import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../memory/db.json');
const backupDir = path.join(__dirname, '../memory');

const SCHEMA_VERSION = 2;
const SR_INTERVALS_DAYS = [1, 3, 7, 14, 30];
const GRADUATED_MASTERY = SR_INTERVALS_DAYS.length;
const TOP_VOCAB = 3;
const TOP_ERRORS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(days) {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

function nextInjectAfterSuccess(newMastery) {
  if (newMastery >= GRADUATED_MASTERY) {
    return new Date(Date.now() + 365 * DAY_MS).toISOString();
  }
  return addDaysIso(SR_INTERVALS_DAYS[newMastery - 1]);
}

function emptyDb() {
  return {
    schema_version: SCHEMA_VERSION,
    vocabulary_upgrades: [],
    grammar_errors: [],
    session_meta: { last_session_at: null, total_sessions: 0 }
  };
}

function migrateV1ToV2(legacy) {
  const created = nowIso();
  const due = created;
  const vocabulary_upgrades = (legacy.vocabulary_upgrades || []).map(v => ({
    word: v.word,
    meaning: v.meaning,
    context: v.context,
    mastery_level: 0,
    times_used_by_ivan: 0,
    created_at: created,
    next_inject_at: due,
    last_used_at: null
  }));
  const grammar_errors = (legacy.grammar_errors || []).map(e => ({
    incorrect: e.incorrect,
    correct: e.correct,
    explanation: e.explanation,
    mastery_level: 0,
    times_repeated: 0,
    created_at: created,
    next_inject_at: due,
    last_seen_at: null
  }));
  return {
    schema_version: SCHEMA_VERSION,
    vocabulary_upgrades,
    grammar_errors,
    session_meta: { last_session_at: null, total_sessions: 0 }
  };
}

function writeBackup(legacyRaw) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `db.v1.backup-${stamp}.json`);
  fs.writeFileSync(backupPath, legacyRaw, 'utf8');
  return backupPath;
}

export class MemoryService {
  loadDb() {
    if (!fs.existsSync(dbPath)) {
      const db = emptyDb();
      this.saveDb(db);
      return db;
    }
    const raw = fs.readFileSync(dbPath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error('memory.js: db.json unreadable, starting fresh after backup.');
      writeBackup(raw);
      const db = emptyDb();
      this.saveDb(db);
      return db;
    }

    if (parsed.schema_version === SCHEMA_VERSION) {
      return parsed;
    }

    const backupPath = writeBackup(raw);
    console.log(`memory.js: migrated v1 -> v2. Backup at ${backupPath}`);
    const migrated = migrateV1ToV2(parsed);
    this.saveDb(migrated);
    return migrated;
  }

  saveDb(db) {
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
  }

  getDueItems(db, now = Date.now()) {
    const isDue = item =>
      item.mastery_level < GRADUATED_MASTERY &&
      new Date(item.next_inject_at).getTime() <= now;

    const order = (a, b) => {
      if (a.mastery_level !== b.mastery_level) return a.mastery_level - b.mastery_level;
      return new Date(a.next_inject_at).getTime() - new Date(b.next_inject_at).getTime();
    };

    const vocab = db.vocabulary_upgrades.filter(isDue).sort(order).slice(0, TOP_VOCAB);
    const errors = db.grammar_errors.filter(isDue).sort(order).slice(0, TOP_ERRORS);
    return { vocab, errors };
  }

  formatForPrompt({ vocab, errors }) {
    const vocabStrings = vocab
      .map(v => `- "${v.word}" (${v.meaning}) — example: ${v.context}`)
      .join('\n');
    const errorStrings = errors
      .map(e => `- Was wrong: "${e.incorrect}" -> right: "${e.correct}" (${e.explanation})`)
      .join('\n');
    return {
      vocabStrings: vocabStrings || 'None.',
      errorStrings: errorStrings || 'None.'
    };
  }

  detectVocabUsage(boostVocab, userTranscript) {
    if (!userTranscript) return new Set();
    const used = new Set();
    for (const v of boostVocab) {
      const escaped = v.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      if (re.test(userTranscript)) used.add(v.word.toLowerCase());
    }
    return used;
  }

  detectErrorRecurrence(boostErrors, summaryErrors) {
    if (!summaryErrors || !summaryErrors.length) return new Set();
    const repeated = new Set();
    const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const newWrongs = summaryErrors.map(e => normalize(e.incorrect));
    for (const e of boostErrors) {
      const target = normalize(e.incorrect);
      if (!target) continue;
      const head = target.slice(0, 6);
      if (newWrongs.some(n => n.startsWith(head) && head.length >= 4)) {
        repeated.add(e.incorrect);
      }
    }
    return repeated;
  }

  applyMasteryProgress(db, boostVocab, usedVocabSet, boostErrors, repeatedErrorSet) {
    const now = nowIso();

    for (const v of boostVocab) {
      const target = db.vocabulary_upgrades.find(
        x => x.word.toLowerCase() === v.word.toLowerCase()
      );
      if (!target) continue;
      const success = usedVocabSet.has(v.word.toLowerCase());
      if (success) {
        target.mastery_level = Math.min(GRADUATED_MASTERY, target.mastery_level + 1);
        target.times_used_by_ivan = (target.times_used_by_ivan || 0) + 1;
        target.last_used_at = now;
        target.next_inject_at = nextInjectAfterSuccess(target.mastery_level);
      } else {
        target.mastery_level = Math.max(0, target.mastery_level - 1);
        target.next_inject_at = addDaysIso(1);
      }
    }

    for (const e of boostErrors) {
      const target = db.grammar_errors.find(
        x => x.incorrect.toLowerCase() === e.incorrect.toLowerCase()
      );
      if (!target) continue;
      const recurred = repeatedErrorSet.has(e.incorrect);
      if (recurred) {
        target.mastery_level = Math.max(0, target.mastery_level - 1);
        target.times_repeated = (target.times_repeated || 0) + 1;
        target.last_seen_at = now;
        target.next_inject_at = addDaysIso(1);
      } else {
        target.mastery_level = Math.min(GRADUATED_MASTERY, target.mastery_level + 1);
        target.next_inject_at = nextInjectAfterSuccess(target.mastery_level);
      }
    }
  }

  mergeNewItems(db, summary) {
    const created = nowIso();
    const due = created;

    if (Array.isArray(summary.vocabulary_upgrades)) {
      for (const v of summary.vocabulary_upgrades) {
        if (!v.word || !v.word.trim()) continue;
        const exists = db.vocabulary_upgrades.some(
          x => x.word.toLowerCase() === v.word.toLowerCase()
        );
        if (exists) continue;
        db.vocabulary_upgrades.push({
          word: v.word,
          meaning: v.meaning,
          context: v.context,
          mastery_level: 0,
          times_used_by_ivan: 0,
          created_at: created,
          next_inject_at: due,
          last_used_at: null
        });
      }
    }

    if (Array.isArray(summary.grammar_errors)) {
      for (const e of summary.grammar_errors) {
        if (!e.incorrect || !e.incorrect.trim()) continue;
        const exists = db.grammar_errors.some(
          x => x.incorrect.toLowerCase() === e.incorrect.toLowerCase()
        );
        if (exists) continue;
        db.grammar_errors.push({
          incorrect: e.incorrect,
          correct: e.correct,
          explanation: e.explanation,
          mastery_level: 0,
          times_repeated: 0,
          created_at: created,
          next_inject_at: due,
          last_seen_at: null
        });
      }
    }
  }

  bumpSessionMeta(db) {
    db.session_meta = db.session_meta || { last_session_at: null, total_sessions: 0 };
    db.session_meta.last_session_at = nowIso();
    db.session_meta.total_sessions = (db.session_meta.total_sessions || 0) + 1;
  }
}
