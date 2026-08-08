/**
 * Pretend stdin is (or isn't) a terminal for the duration of a test.
 *
 * A test that mocks `@inquirer/prompts` is simulating a user sitting at a prompt, but
 * mocking the prompt library alone isn't enough: the interactive helpers first check
 * `process.stdin.isTTY` and refuse to prompt without a terminal. Under vitest stdin is
 * never a TTY, so those tests must say so explicitly.
 *
 * `isTTY` is a plain data property — absent entirely when stdin isn't a terminal — so it
 * has to be redefined rather than spied on. Returns a restore function; call it in the
 * test's cleanup path so the setting can't leak into another file.
 */
export function setFakeTTY(isTTY: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true, writable: true })
  return () => {
    if (original) Object.defineProperty(process.stdin, 'isTTY', original)
    else delete (process.stdin as { isTTY?: boolean }).isTTY
  }
}
