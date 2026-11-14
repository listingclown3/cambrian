#!/usr/bin/env node
/**
 * generate_scouting.mjs
 *
 * Generates deliberately messy, FABRICATED FRC-style scouting sheets for the
 * robots listed in a profiles JSON file. For each robot it writes one sheet to
 * <out>/sheets/<sheetId>.<ext>, rotating formats csv / md / txt / html by
 * robot index, plus a <out>/truth.json describing what each sheet states.
 *
 * Messiness: varied units (converted from the input), varied wording, varied
 * booleans, 2-5 omitted profile fields per sheet (never mentioned anywhere),
 * irrelevant chatter, occasional self-corrections (the later value is the
 * true one), and the occasional typo in an ordinary word.
 *
 * Deterministic: all randomness comes from a mulberry32 PRNG seeded with the
 * --seed value. Same seed + same input => byte-identical output.
 *
 * Usage: node generate_scouting.mjs --profiles profiles.json --out out --seed 2103
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------- command line ----------
function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > -1 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
const profilesPath = arg('--profiles');
const outDir = arg('--out');
const seed = arg('--seed');
if (!profilesPath || !outDir || seed === undefined) {
  console.error('usage: node generate_scouting.mjs --profiles <file> --out <dir> --seed <int>');
  process.exit(1);
}
const SEED = parseInt(seed, 10);

// ---------- tiny seeded RNG (mulberry32) ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
function shuffle(r, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const r1 = (x) => Math.round(x * 10) / 10;
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);

// ---------- constants ----------
const FT_PER_M = 3.28084;
const LB_PER_KG = 2.20462;
const FIELDS = ['shooterType', 'lanes', 'shootOnMove', 'capacity', 'fireRatePerS',
  'intakeWidth', 'drivetrain', 'speedEmptyMps', 'massEmptyKg', 'heightClass',
  'fitsUnderTrench', 'climbLevel', 'passRangeM'];
const NUMERIC = ['capacity', 'fireRatePerS', 'speedEmptyMps', 'massEmptyKg', 'passRangeM', 'lanes'];
const FORMATS = ['csv', 'md', 'txt', 'html'];

// field labels per format
const CSV_LABEL = {
  teamNumber: 'Team', shooterType: 'Shtr', lanes: 'Ln', shootOnMove: 'SOTM',
  capacity: 'Cap (balls)', fireRatePerS: 'Rate', intakeWidth: 'Intake',
  drivetrain: 'Dtrn', speedEmptyMps: 'Spd', massEmptyKg: 'Wt',
  heightClass: 'Ht', fitsUnderTrench: 'Trench', climbLevel: 'Clmb', passRangeM: 'Pass',
};
const MD_LABEL = {
  shooterType: 'Shooter', lanes: 'Lanes', shootOnMove: 'Shoot on move',
  capacity: 'Hopper', fireRatePerS: 'Fire rate', intakeWidth: 'Intake',
  drivetrain: 'Drivetrain', speedEmptyMps: 'Top speed (empty)',
  massEmptyKg: 'Weight (empty)', heightClass: 'Height', fitsUnderTrench: 'Trench fit',
  climbLevel: 'Climb', passRangeM: 'Pass range',
};
const HTML_LABEL = { ...MD_LABEL, teamNumber: 'Team' };

// irrelevant chatter; values must not contain digits
const CHATTER = [
  ['Team name', 'Blue Cheetahs'], ['Team name', 'the Orange Owls'], ['Team name', 'Red Rooks'],
  ['Battery', 'looked fresh'], ['Battery', 'was kind of tired'],
  ['Pit', 'back row by the big window'], ['Pit', 'corner spot, hard to see from the fence'],
  ['Bumpers', 'scratched but okay'], ['Bumpers', 'new, pretty clean'],
  ['Kids', 'nice kids'], ['Crew', 'seemed chill'],
  ['Smell', 'hot plastic in the pit'],
];
// typo pairs: [word, typo] — filler words only, never numbers, units or field values
const TYPOS = [['the', 'teh'], ['battery', 'batery'], ['window', 'windo'], ['smell', 'smel']];

function applyTypos(r, text) {
  let out = text;
  let n = r() < 0.35 ? (r() < 0.3 ? 2 : 1) : 0;
  for (const [w, t] of shuffle(r, TYPOS)) {
    if (n <= 0) break;
    const re = new RegExp(`\\b${w}`, 'i');
    if (re.test(out)) {
      out = out.replace(re, t);
      n--;
    }
  }
  return out;
}

// ---------- per-sheet rendering ----------
function makeRenderers(p, r, units, stated) {
  const H = stated.has('heightClass');
  const L = stated.has('lanes');
  const S = stated.has('shooterType');
  const speedStr = (m) => {
    const v = units.speed === 'm/s' ? f1(m) : f1(m * FT_PER_M);
    const u = units.speed === 'm/s' ? 'm/s' : units.speed === 'fps' ? 'fps' : units.speed === 'ft/s' ? 'ft/s' : 'feet per second';
    return `${v} ${u}`;
  };
  return {
    teamNumber: (n) => pick(r, [`Team ${n}`, `team ${n}`, `Team #${n}`]),
    shooterType: (v) => v === 'drum' ? pick(r, ['drum', 'drum shooter', 'drum on a riser'])
      : v === 'lanes' ? !S ? 'lanes'
        : L ? pick(r, p.lanes > 1 ? ['lanes', `${p.lanes} lane shooter`] : ['lanes', '1 lane shooter'])
        : pick(r, ['lanes', 'lane shooter'])
      : v === 'turret' ? pick(r, ['turret', 'turreted shooter'])
      : v === 'dumper' ? pick(r, ['dumper', 'low dumper'])
      : pick(r, ['no shooter', 'defense bot, no shooter']),
    lanes: (n) => `${n}`,
    shootOnMove: (b) => b ? pick(r, ['yes', 'Y', 'SOTM']) : pick(r, ['no', 'N', 'must stop to shoot']),
    capacity: (n) => pick(r, [`holds ${n} balls`, `carries ${n} balls`, `capacity ${n}`]),
    fireRatePerS: (n) => pick(r, [`${f1(n)}/s`, `${f1(n)} shots/s`]),
    intakeWidth: (v) => pick(r, [v, `${v} intake`]),
    drivetrain: (v) => v === 'swerve' ? pick(r, ['swerve', 'swerve drive', 'MK4i swerve'])
        : pick(r, ['tank', '6 wheel tank', 'WCD']),
    speedEmptyMps: speedStr,
    massEmptyKg: (kg) => units.weight === 'kg' ? `${f1(kg)} kg` : `${f1(kg * LB_PER_KG)} ${units.weight}`,
    heightClass: (v) => v,
    fitsUnderTrench: (b) => b ? pick(r, ['yes', 'Y', 'fits under trench'])
      : H ? pick(r, ['no', 'N', 'too tall for the trench'])
      : pick(r, ['no', 'N', 'does not fit under the trench']),
    climbLevel: (n) => n === 0 ? pick(r, ['none', 'no climb'])
      : n === 1 ? pick(r, ['low (1)', '1 of 3'])
      : n === 2 ? pick(r, ['mid (2)', '2 of 3'])
      : pick(r, ['high (3)', '3 of 3']),
    passRangeM: (m) => m === 0 ? pick(r, ['no pass', "can't pass"])
      : units.pass === 'm' ? pick(r, [`${f1(m)} m`, `passes ${f1(m)} m`])
      : pick(r, [`${f1(m * FT_PER_M)} ft`, `passes ${f1(m * FT_PER_M)} ft`]),
  };
}

// wrong value for a numeric field + the "actually ..." fix text (true value)
function makeCorrection(key, p, r, R) {
  let wrong, fix;
  const sign = () => (r() < 0.5 ? -1 : 1);
  if (key === 'capacity') {
    wrong = R.capacity(Math.max(1, p.capacity + sign() * (1 + Math.floor(r() * 8))));
    fix = `actually ${R.capacity(p.capacity)}`;
  } else if (key === 'fireRatePerS') {
    let w = r1(Math.max(0.2, p.fireRatePerS + sign() * (0.3 + r() * 1.7)));
    if (w === r1(p.fireRatePerS)) w = r1(w + 1);
    wrong = R.fireRatePerS(w);
    fix = `actually ${R.fireRatePerS(p.fireRatePerS)}`;
  } else if (key === 'speedEmptyMps') {
    const w = r1(Math.max(0.5, p.speedEmptyMps + sign() * (0.3 + r() * 0.9)));
    wrong = R.speedEmptyMps(w);
    fix = `actually ${R.speedEmptyMps(p.speedEmptyMps)}`;
  } else if (key === 'massEmptyKg') {
    wrong = R.massEmptyKg(Math.max(5, p.massEmptyKg + sign() * (2 + r() * 6)));
    fix = `actually ${R.massEmptyKg(p.massEmptyKg)}`;
  } else if (key === 'passRangeM') {
    const w = r1(Math.max(0.2, p.passRangeM + sign() * (0.3 + r() * 1.2)));
    wrong = R.passRangeM(w);
    fix = `actually ${R.passRangeM(p.passRangeM)}`;
  } else { // lanes
    let w = p.lanes + (p.lanes > 2 ? -1 : 1);
    if (w < 1) w = 2;
    wrong = R.lanes(w);
    fix = `actually ${R.lanes(p.lanes)}`;
  }
  return { wrong, fix };
}

function csvCell(s) {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function txtSentence(k, v) {
  switch (k) {
    case 'shooterType': return `shooter: ${v}.`;
    case 'lanes': return `lane count is ${v}.`;
    case 'shootOnMove': return v === 'SOTM' ? 'shoots on the move, SOTM yes.'
      : v === 'must stop to shoot' ? 'has to stop to shoot.'
      : v === 'yes' || v === 'Y' ? 'shoots on the move.'
      : 'does not shoot on the move.';
    case 'capacity': return `hopper ${v}.`;
    case 'fireRatePerS': return `fire rate ${v}.`;
    case 'intakeWidth': return `intake ${v}.`;
    case 'drivetrain': return `drive: ${v}.`;
    case 'speedEmptyMps': return `top speed ${v} empty.`;
    case 'massEmptyKg': return `weighs ${v} empty.`;
    case 'heightClass': return `it's ${v}.`;
    case 'fitsUnderTrench': return v === 'yes' || v === 'Y' ? 'fits under trench.'
      : v === 'no' || v === 'N' ? "does not fit under trench."
      : `${v}.`;
    case 'climbLevel': return `climb ${v}.`;
    case 'passRangeM': return v === "no pass" || v === "can't pass" ? "it can't pass."
      : v.startsWith('passes') ? `it ${v}.` : `pass range is ${v}.`;
    default: return `${v}.`;
  }
}

function buildSheet(robot, index, seedVal) {
  const r = mulberry32((seedVal ^ Math.imul(index + 1, 0x9E3779B9)) >>> 0);
  const p = robot.profile;
  const fmt = FORMATS[index % 4];
  const units = {
    speed: pick(r, ['m/s', 'ft/s', 'fps', 'feet per second']),
    weight: pick(r, ['kg', 'lb', 'lbs']),
    pass: pick(r, ['m', 'ft']),
  };
  const omitted = new Set(shuffle(r, FIELDS).slice(0, 2 + Math.floor(r() * 4)));
  const stated = new Set(['teamNumber', ...FIELDS.filter((f) => !omitted.has(f))]);
  const R = makeRenderers(p, r, units, stated);
  const vals = {};
  for (const k of stated) vals[k] = R[k](k === 'teamNumber' ? robot.teamNumber : p[k]);

  // chatter (3-5 items, unique labels)
  const chatter = [];
  for (const [label, value] of shuffle(r, CHATTER)) {
    if (chatter.length >= 3 + Math.floor(r() * 3)) break;
    if (!chatter.some(([l]) => l === label)) chatter.push([label, value]);
  }

  // correction: about one sheet in four
  let correction = null;
  if (r() < 0.25) {
    const cand = shuffle(r, NUMERIC.filter((k) => stated.has(k)));
    const key = cand[0];
    correction = { key, ...makeCorrection(key, p, r, R) };
    vals[key] = correction.wrong; // early note is wrong
  }

  const truth = {};
  truth.teamNumber = robot.teamNumber;
  for (const k of FIELDS) if (stated.has(k)) truth[k] = p[k];

  let text;
  if (fmt === 'csv') {
    const rows = [['field', 'value', 'notes']];
    for (const k of stated) rows.push([CSV_LABEL[k], vals[k], '']);
    for (const [l, v] of chatter) rows.push([l, v, '']);
    if (correction) rows.push(['note', `update: ${correction.fix}`, '']);
    text = rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
  } else if (fmt === 'md') {
    const lines = [`# Pit notes — ${vals.teamNumber}`, '', '## bot'];
    for (const k of FIELDS) if (stated.has(k)) lines.push(`- ${MD_LABEL[k]}: ${vals[k]}`);
    lines.push('', '## pit');
    for (const [l, v] of chatter) lines.push(`- ${l}: ${v}`);
    if (correction) lines.push(`- update: ${correction.fix}`);
    text = lines.join('\n') + '\n';
  } else if (fmt === 'txt') {
    const lines = [`pit notes for ${vals.teamNumber}, wrote these in a hurry.`];
    for (const k of FIELDS) if (stated.has(k)) lines.push(txtSentence(k, vals[k]));
    for (const [l, v] of chatter) lines.push(`${l} ${v}.`);
    if (correction) lines.push(`oh wait — ${correction.fix}.`);
    text = lines.join(' ') + '\n';
  } else { // html
    const rows = [];
    for (const k of stated) rows.push(`<tr><th>${HTML_LABEL[k]}</th><td>${vals[k]}</td></tr>`);
    for (const [l, v] of chatter) rows.push(`<tr><th>${l}</th><td>${v}</td></tr>`);
    if (correction) rows.push(`<tr><th>Note</th><td>update: ${correction.fix}</td></tr>`);
    text = ['<!doctype html>', '<html>', '<head>', '<meta charset="utf-8">',
      `<title>scout form — ${vals.teamNumber}</title>`, '</head>', '<body>',
      `<h1>Scout form — ${vals.teamNumber}</h1>`, '<form>', '<table>',
      ...rows, '</table>', '</form>', '</body>', '</html>'].join('\n') + '\n';
  }

  return {
    file: `${robot.sheetId}.${fmt}`,
    format: fmt,
    hasCorrection: !!correction,
    stated: truth,
    text: applyTypos(r, text),
  };
}

// ---------- main ----------
const input = JSON.parse(readFileSync(profilesPath, 'utf8'));
const robots = input.robots;
mkdirSync(join(outDir, 'sheets'), { recursive: true });

const truthSheets = [];
const counts = { csv: 0, md: 0, txt: 0, html: 0 };
let corrections = 0;
for (let i = 0; i < robots.length; i++) {
  const sheet = buildSheet(robots[i], i, SEED);
  writeFileSync(join(outDir, 'sheets', sheet.file), sheet.text, 'utf8');
  counts[sheet.format]++;
  if (sheet.hasCorrection) corrections++;
  truthSheets.push({
    sheetId: robots[i].sheetId,
    file: sheet.file,
    format: sheet.format,
    archetype: robots[i].archetype,
    hasCorrection: sheet.hasCorrection,
    stated: sheet.stated,
  });
}
const truth = {
  note: 'FABRICATED scouting sheets for testing document extraction. Not real teams.',
  seed: SEED,
  sheets: truthSheets,
};
writeFileSync(join(outDir, 'truth.json'), JSON.stringify(truth, null, 2) + '\n', 'utf8');
console.log(`wrote ${robots.length} sheets to ${outDir}/sheets `
  + `(${counts.csv} csv, ${counts.md} md, ${counts.txt} txt, ${counts.html} html), `
  + `${corrections} with corrections, seed ${SEED}`);
