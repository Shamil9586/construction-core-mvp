// Construction Core — GPR-2 CI Foundation: pinned external input documents (never in the repository).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Pinned external documents of one test file (profile files[].external_inputs). They are never in the repository: the approved transport places them
 * in $GPR2_EXTERNAL_INPUTS_DIR, outside the candidate tree. Each must be a regular file (no link) whose SHA-256 equals the pin; only then is its path
 * handed to THAT file's process (the directory variable itself never reaches a candidate process). Anything else is a refusal, never a skipped test.
 * Returns { env } for the child, { records } for the evidence, or { reason }.
 */
export function resolveExternalInputs(inputs, dir = process.env.GPR2_EXTERNAL_INPUTS_DIR) {
  if (!inputs || inputs.length === 0) return { env: {}, records: [] };
  if (!dir || !path.isAbsolute(dir)) return { reason: 'GPR2_EXTERNAL_INPUTS_DIR is not set to an absolute directory: the pinned external documents were not supplied' };
  const env = {}, records = [];
  for (const x of inputs) {
    const f = path.join(dir, x.filename);
    let st = null; try { st = fs.lstatSync(f); } catch { /* reported below */ }
    if (!st || !st.isFile() || st.isSymbolicLink()) return { reason: `external input ${x.filename} is missing or is not a regular file` };
    const buf = fs.readFileSync(f);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== x.sha256) return { reason: `external input ${x.filename} has sha256 ${sha}, pinned ${x.sha256}` };
    env[x.env] = f; records.push({ env: x.env, filename: x.filename, sha256: sha, bytes: buf.length });
  }
  return { env, records };
}
