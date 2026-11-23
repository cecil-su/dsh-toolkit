import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { win32 as path } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
// Anchor to an imperative at the start, not a mention, question or quoted example.
const request = /^(?:请[ \t]*)?(?:在[ \t]*DSH[ \t]*(?:中[ \t]*)?)?(?:开启|执行|继续)[ \t]*(?:(?:Agent[ \t]+)?Steward[ \t]*)?(?:(?:任务|Task)[ \t]*)?#([1-9]\d{0,15})(?=$|[\s，,。！!；;]|\.(?=\s|$))/iu

/** Windows Steward installation. A miss is not an error and must not block ordinary naming. */
export async function lookupTitle(text, signal) {
  if (process.platform !== 'win32' || signal?.aborted || typeof text !== 'string' || text.length > 65536) return
  const first = text.trim()
  const id = request.exec(first)?.[1]
  if (!id || !Number.isSafeInteger(Number(id)) || /[?？]/u.test(first.split(/[，,。！!；;\r\n]/u, 1)[0])) return

  try {
    const local = process.env.LOCALAPPDATA
    if (!local || !path.isAbsolute(local)) return
    const dir = path.join(local, 'agent-steward')
    // Do not resolve a same-named executable from the workspace or an untrusted PATH.
    const exe = path.join(homedir(), '.cargo', 'bin', 'taskctl.exe')
    const args = ['--database', path.join(dir, 'steward.db'), 'task', 'context', id, '--require-read-only']
    const { stdout } = await run(exe, args, {
      cwd: dir, shell: false, windowsHide: true, encoding: 'utf8', timeout: 2500,
      maxBuffer: 512 * 1024, signal,
    })
    if (signal?.aborted) return
    // Read only the first heading, not subheadings or lookalikes inside the task body.
    const match = /^\uFEFF?# Task #(\d+) — ([^\r\n]+)(?:\r?\n|$)/u.exec(stdout)
    const title = match?.[2].trim()
    if (match?.[1] !== id || !title || title.length > 512 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(title)) return
    return title
  } catch {
    return undefined
  }
}
