const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 50);

const paths = {
  dataDir: path.join(__dirname, 'data'),
  dataFile: path.join(__dirname, 'data', 'courses.json'),
  backupDir: path.join(__dirname, 'backups'),
  logDir: path.join(__dirname, 'logs'),
  publicDir: path.resolve(__dirname, '..')
};

ensureDirectories();

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is not set. Define it in server/.env before starting the server.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(paths.publicDir));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'alive' });
});

app.get('/api/courses', async (_req, res) => {
  try {
    const courses = await readCourses();
    res.json({ data: courses });
  } catch (err) {
    console.error('Failed to read courses:', err);
    res.status(500).json({ error: 'Failed to read courses' });
  }
});

app.post('/api/courses', requireAdmin, async (req, res) => {
  const payload = req.body || {};
  const errors = validateCourse(payload, { partial: false });
  if (errors.length) {
    return res.status(400).json({ error: 'Invalid payload', details: errors });
  }

  const newCourse = {
    ...cleanCoursePayload(payload),
    id: uuidv4(),
    updatedAt: new Date().toISOString()
  };

  try {
    const courses = await updateCourses(list => [newCourse, ...list]);
    res.status(201).json({ data: newCourse, total: courses.length });
  } catch (err) {
    console.error('Failed to add course:', err);
    res.status(500).json({ error: 'Failed to add course' });
  }
});

app.put('/api/courses/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const payload = req.body || {};
  const errors = validateCourse(payload, { partial: true });
  if (errors.length) {
    return res.status(400).json({ error: 'Invalid payload', details: errors });
  }

  try {
    let updated;
    const courses = await updateCourses(list => {
      const idx = list.findIndex(item => item.id === id);
      if (idx === -1) {
        throw new Error('not_found');
      }
      const current = list[idx];
      const next = {
        ...current,
        ...cleanCoursePayload(payload),
        updatedAt: new Date().toISOString()
      };
      const nextList = [...list];
      nextList[idx] = next;
      updated = next;
      return nextList;
    });
    res.json({ data: updated, total: courses.length });
  } catch (err) {
    if (err.message === 'not_found') {
      return res.status(404).json({ error: 'Course not found' });
    }
    console.error('Failed to update course:', err);
    res.status(500).json({ error: 'Failed to update course' });
  }
});

app.delete('/api/courses/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    let removed = null;
    const courses = await updateCourses(list => {
      const idx = list.findIndex(item => item.id === id);
      if (idx === -1) {
        throw new Error('not_found');
      }
      removed = list[idx];
      const next = [...list];
      next.splice(idx, 1);
      return next;
    });
    res.json({ data: removed, total: courses.length });
  } catch (err) {
    if (err.message === 'not_found') {
      return res.status(404).json({ error: 'Course not found' });
    }
    console.error('Failed to delete course:', err);
    res.status(500).json({ error: 'Failed to delete course' });
  }
});

app.post('/api/courses/raw', requireAdmin, async (req, res) => {
  const payload = req.body;
  if (!Array.isArray(payload)) {
    return res.status(400).json({ error: 'Payload must be an array' });
  }

  // basic validation on each item
  for (let i = 0; i < payload.length; i++) {
    const item = payload[i];
    if (!item || typeof item !== 'object') {
      return res.status(400).json({ error: `Item at index ${i} is not an object` });
    }
    if (!item.type || !['course', 'live'].includes(item.type)) {
      return res.status(400).json({ error: `Item at index ${i} has invalid type` });
    }
  }

  // ensure ids and updatedAt
  const normalized = payload.map(item => ({
    ...item,
    id: item.id || uuidv4(),
    updatedAt: item.updatedAt || new Date().toISOString()
  }));

  try {
    await updateCourses(() => normalized);
    res.json({ ok: true, total: normalized.length });
  } catch (err) {
    console.error('Failed to replace courses:', err);
    res.status(500).json({ error: 'Failed to replace courses' });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

async function readCourses() {
  const raw = await fs.promises.readFile(paths.dataFile, 'utf8');
  if (!raw.trim()) return [];
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error('courses.json is not an array');
  }
  return data;
}

let writeQueue = Promise.resolve();

function updateCourses(mutator) {
  writeQueue = writeQueue.then(async () => {
    const rawBefore = await fs.promises.readFile(paths.dataFile, 'utf8');
    const current = rawBefore.trim() ? JSON.parse(rawBefore) : [];
    const next = mutator(current);
    const serialized = JSON.stringify(next, null, 2);

    if (rawBefore.trim()) {
      await createBackup(rawBefore);
    }

    const tmpFile = `${paths.dataFile}.tmp`;
    await fs.promises.writeFile(tmpFile, serialized, 'utf8');
    await fs.promises.rename(tmpFile, paths.dataFile);
    await pruneBackups();
    return next;
  });

  return writeQueue;
}

async function createBackup(rawContent) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const target = path.join(paths.backupDir, `courses-${stamp}.json.gz`);
  const gz = zlib.gzipSync(Buffer.from(rawContent, 'utf8'));
  await fs.promises.writeFile(target, gz);
}

async function pruneBackups() {
  if (!Number.isFinite(BACKUP_KEEP) || BACKUP_KEEP < 1) return;
  const files = await fs.promises.readdir(paths.backupDir);
  const backups = [];
  for (const file of files) {
    if (!file.endsWith('.json.gz')) continue;
    const fullPath = path.join(paths.backupDir, file);
    const stat = await fs.promises.stat(fullPath);
    backups.push({ file: fullPath, mtime: stat.mtimeMs });
  }
  backups.sort((a, b) => b.mtime - a.mtime);
  const toRemove = backups.slice(BACKUP_KEEP);
  await Promise.all(toRemove.map(item => fs.promises.unlink(item.file)));
}

function validateCourse(payload, { partial }) {
  const errors = [];
  const present = key => Object.prototype.hasOwnProperty.call(payload, key);

  if (!partial) {
    if (!present('type')) errors.push('type is required');
    if (!['live', 'course'].includes(payload.type)) errors.push('type must be live or course');
  }

  if (present('type') && !['live', 'course'].includes(payload.type)) {
    errors.push('type must be live or course');
  }

  const checkString = (value, field, opts = {}) => {
    if (typeof value !== 'string') {
      errors.push(`${field} must be a string`);
      return;
    }
    const trimmed = value.trim();
    if (!trimmed && !opts.allowEmpty) {
      errors.push(`${field} is required`);
      return;
    }
    if (opts.max && trimmed.length > opts.max) {
      errors.push(`${field} is too long (max ${opts.max})`);
    }
  };

  if (payload.type === 'live' || (!partial && payload.type === undefined)) {
    if (present('title')) checkString(payload.title, 'title', { max: 200 });
    if (present('link')) checkString(payload.link, 'link', { max: 500 });
    if (present('meetingNumber')) checkString(payload.meetingNumber, 'meetingNumber', { max: 100, allowEmpty: true });
  }

  if (payload.type === 'course' || (!partial && payload.type === undefined)) {
    ['lessonLabel', 'topic', 'datetimeText'].forEach(field => {
      if (!partial && !present(field)) errors.push(`${field} is required`);
      if (present(field)) checkString(payload[field], field, { max: 300 });
    });
    if (present('replayLink')) checkString(payload.replayLink, 'replayLink', { max: 500 });

    if (present('materials')) {
      if (!Array.isArray(payload.materials)) {
        errors.push('materials must be an array');
      } else {
        payload.materials.forEach((m, idx) => {
          if (typeof m !== 'object' || m === null) {
            errors.push(`materials[${idx}] must be an object`);
            return;
          }
          if (m.url !== undefined) checkString(m.url, `materials[${idx}].url`, { max: 500 });
          if (m.title !== undefined) checkString(m.title, `materials[${idx}].title`, { max: 200 });
          if (m.subtitle !== undefined) checkString(m.subtitle, `materials[${idx}].subtitle`, { max: 200, allowEmpty: true });
        });
      }
    }

    if (present('instructor')) {
      const inst = payload.instructor;
      if (typeof inst !== 'object' || inst === null) {
        errors.push('instructor must be an object');
      } else {
        if (inst.name !== undefined) checkString(inst.name, 'instructor.name', { max: 120 });
        if (inst.avatar !== undefined) checkString(inst.avatar, 'instructor.avatar', { max: 500 });
        if (inst.qqLink !== undefined) checkString(inst.qqLink, 'instructor.qqLink', { max: 500 });
        if (inst.bio !== undefined) checkString(inst.bio, 'instructor.bio', { max: 400, allowEmpty: true });
      }
    }
  }

  return errors;
}

function cleanCoursePayload(payload) {
  const cleaned = {};
  const copy = (key) => {
    if (payload[key] !== undefined) cleaned[key] = payload[key];
  };
  ['type', 'title', 'link', 'meetingNumber', 'lessonLabel', 'topic', 'datetimeText', 'replayLink', 'materials', 'instructor', 'status'].forEach(copy);
  return cleaned;
}

function requireAdmin(req, res, next) {
  const token = req.header('X-Admin-Token');
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function ensureDirectories() {
  [paths.dataDir, paths.backupDir, paths.logDir].forEach(dir => {
    fs.mkdirSync(dir, { recursive: true });
  });
  if (!fs.existsSync(paths.dataFile)) {
    fs.writeFileSync(paths.dataFile, '[]', 'utf8');
  }
}
