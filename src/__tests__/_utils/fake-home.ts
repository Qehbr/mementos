/**
 * Point the process at a fake home directory for the duration of a test.
 *
 * Sets HOME (what `os.homedir()` reads on POSIX) AND USERPROFILE (what it
 * reads on Windows). Setting HOME alone passes on Linux/macOS but silently
 * leaves every test on Windows operating on the runner's REAL home
 * directory — tests then contaminate each other through shared config,
 * which is exactly what the first Windows CI run showed.
 *
 * Returns a restore function; call it in the test's cleanup path.
 */
export function setFakeHome(dir: string): () => void {
  const orig = { home: process.env['HOME'], profile: process.env['USERPROFILE'] }
  process.env['HOME'] = dir
  process.env['USERPROFILE'] = dir
  return () => {
    if (orig.home === undefined) delete process.env['HOME']
    else process.env['HOME'] = orig.home
    if (orig.profile === undefined) delete process.env['USERPROFILE']
    else process.env['USERPROFILE'] = orig.profile
  }
}
