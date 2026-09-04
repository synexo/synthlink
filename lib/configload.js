'use strict';
/*
 * lib/configload.js — read a config file, or refuse to start.
 *
 * Both config files go through here, and they behave identically: a file that is
 * missing, unparseable, or carries a value or a key that cannot be understood is
 * a FATAL error. The caller records it and server.js exits before anything binds
 * a port.
 *
 * This replaces a best-effort loader, and the reasoning for that loader was not
 * silly — "a server that will not start because its cosmetic config has a stray
 * comma is a worse failure than one running under its default name". It is
 * simply wrong for this application, for three reasons found by reading what it
 * actually did:
 *
 *   - a stray comma is a JSON parse error, and the old loader answered that by
 *     falling back to EVERY default. The operator's whole configuration was
 *     discarded in silence — the security settings along with the brand name.
 *     The failure it was defending against was the smallest part of what it did.
 *
 *   - `trustProxy: "no"`, which is what an operator writes when they mean to
 *     stop believing forwarded headers, is a truthy string. It was kept
 *     verbatim, the check `if (!cfg.trustProxy)` passed straight over it, and
 *     the headers went on being believed. The setting did nothing and nothing
 *     said so. `requireListedForAllDials: "true"` has the same shape and fails
 *     the other way: the operator believes listed-only mode is on and it is off.
 *
 *   - a key with a typo in it — `blockedPort` for `blockedPorts` — was ignored
 *     entirely. That is the cheapest way there is to end up with an unarmed
 *     control and a config file that reads as though it is armed.
 *
 * The common thread is that every one of them leaves an operator believing in
 * protection they do not have, which is worse than any startup failure. So there
 * is no cosmetic exemption: a carve-out for the harmless-looking settings is
 * exactly the cover a security setting slips through under.
 *
 * SynthLink's own code, GPL-3.0-or-later.
 */

const fs = require('fs');

/**
 * @typedef {object} Rule
 * @property {'string'|'int'|'number'|'bool'|'enum'|'array'} type
 * @property {number} [min] inclusive, for int/number
 * @property {number} [max] inclusive, for int/number
 * @property {string[]} [values] for enum
 * @property {(v:any)=>string|null} [check] extra validation; returns a reason or null
 */

/** Describe a value the way an error message should say it. */
function shown(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `a list of ${v.length}`;
  if (v === null) return 'null';
  if (typeof v === 'object') return 'an object';
  return String(v);
}

/** One value against one rule → a reason it is wrong, or null. */
function checkValue(key, v, rule) {
  switch (rule.type) {
    case 'string':
      if (typeof v !== 'string') return `${key} must be a string, not ${shown(v)}`;
      break;
    case 'bool':
      // The case that made this file necessary. "no", "false" and "off" are all
      // truthy strings, and every one of them is what somebody writes when they
      // mean the opposite.
      if (typeof v !== 'boolean') {
        return `${key} must be true or false (unquoted), not ${shown(v)}`;
      }
      break;
    case 'int':
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return `${key} must be a number, not ${shown(v)}`;
      }
      if (rule.type === 'int' && !Number.isInteger(v)) {
        return `${key} must be a whole number, not ${shown(v)}`;
      }
      if (rule.min !== undefined && v < rule.min) {
        return `${key} is ${v}; the minimum is ${rule.min}`;
      }
      if (rule.max !== undefined && v > rule.max) {
        return `${key} is ${v}; the maximum is ${rule.max}`;
      }
      break;
    }
    case 'enum':
      if (typeof v !== 'string' || !rule.values.includes(v)) {
        return `${key} must be one of ${rule.values.join(', ')}, not ${shown(v)}`;
      }
      break;
    case 'array':
      if (!Array.isArray(v)) return `${key} must be a list, not ${shown(v)}`;
      break;
    default:
      return `${key} has no validation rule — this is a bug in the config schema`;
  }
  return rule.check ? rule.check(v) : null;
}

/**
 * Read and validate a config file.
 *
 * @param {string} file           absolute path
 * @param {string} label          how to name it in errors, e.g. 'config/site.json'
 * @param {object} defaults       every legal key, with its default value
 * @param {Object<string,Rule>} rules  one per key
 * @param {Object<string,string>} [moved] keys that USED to be here → what to say
 * @returns {{cfg: object, fatal: string|null}}
 *
 * `fatal` is returned rather than thrown so that a module can be required
 * without exploding — the decision to stop belongs to server.js, in one place,
 * before it listens.
 */
function loadConfigFile(file, label, defaults, rules, moved = {}) {
  const cfg = { ...defaults };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { cfg, fatal: `${label} is missing. It is required — this server does not ` +
                           'run on defaults, because a configuration nobody wrote is a ' +
                           'configuration nobody has checked.' };
    }
    return { cfg, fatal: `${label} cannot be read (${e.message})` };
  }

  let file_;
  try {
    file_ = JSON.parse(raw);
  } catch (e) {
    // Previously this fell back to every default, discarding the operator's
    // entire configuration over one comma, without stopping.
    return { cfg, fatal: `${label} is not valid JSON (${e.message})` };
  }
  if (!file_ || typeof file_ !== 'object' || Array.isArray(file_)) {
    return { cfg, fatal: `${label} must contain a JSON object` };
  }

  const problems = [];

  // Unknown keys first: a typo'd key name is the cheapest way to end up with an
  // unarmed control, and it is invisible unless something says so. Keys starting
  // with _ are notes — the shipped files use "_comment" for their documentation.
  for (const k of Object.keys(file_)) {
    if (k.startsWith('_')) continue;
    if (Object.prototype.hasOwnProperty.call(defaults, k)) continue;
    if (moved[k]) { problems.push(`${k}: ${moved[k]}`); continue; }
    const near = Object.keys(defaults).find(
      (d) => d.toLowerCase() === k.toLowerCase() ||
             d.toLowerCase().startsWith(k.toLowerCase().slice(0, 6)));
    problems.push(`${k} is not a setting this file has` + (near ? ` — did you mean ${near}?` : ''));
  }

  for (const k of Object.keys(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(file_, k)) continue;   // absent = default
    const rule = rules[k];
    if (!rule) { problems.push(`${k} has no validation rule — bug in the config schema`); continue; }
    const why = checkValue(k, file_[k], rule);
    if (why) problems.push(why);
    else cfg[k] = Array.isArray(file_[k]) ? file_[k].slice() : file_[k];
  }

  if (problems.length) {
    return { cfg, fatal: `${label}: ${problems.join('; ')}` };
  }
  return { cfg, fatal: null };
}

module.exports = { loadConfigFile, checkValue };
