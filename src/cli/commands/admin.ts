/**
 * Post-init administrative subcommands, all under `mementos integration`:
 *   - `mementos integration list`                  — which AI clients have mementos registered
 *   - `mementos integration enable|disable <name>` — install / uninstall mementos for a client
 *   - `mementos integration hook enable|disable|status <name> [--type=auto-retrieve|pre-compact]`
 *                                                  — manage a client's hooks
 *
 * All operate on already-initialised vaults; they do NOT prompt or run setupAtInit. They
 * call directly into the integration's lifecycle methods.
 *
 * The `hook` subcommand discovers hook-capable integrations via the optional
 * `hooks?: HookSurface` field on `ClientIntegration`. A new integration opts in by setting
 * `readonly hooks = new HookRegistry(...)`; no edit here is needed.
 */
import { loadIntegrations } from '../../integrations/registry.js'
import type { ClientIntegration, HookSurface } from '../../integrations/interface.js'
import { buildKeyProvider, readMachineConfigOrExit } from '../_utils/vault.js'
import { parseFlag } from '../_utils/flags.js'

interface HookCapable {
  name: string
  integration: ClientIntegration & { hooks: HookSurface }
}

/** Find every registered integration that exposes a hook surface. */
async function findHookCapable(): Promise<HookCapable[]> {
  const reg = await loadIntegrations()
  const out: HookCapable[] = []
  for (const [name, impl] of reg) {
    const integration = impl.create()
    if (integration.hooks) out.push({ name, integration: integration as HookCapable['integration'] })
  }
  return out
}

/**
 * Resolve the `--type=` flag to a hook kind. Defaults to the first kind the integration
 * declares (typically 'auto-retrieve'). Rejects unknown kinds with a pointer at what's
 * available.
 */
function resolveHookKind(target: HookCapable): string {
  const supported = target.integration.hooks.supportedHooks()
  const fromFlag = parseFlag('type')
  if (fromFlag === undefined || fromFlag === '') {
    if (supported.length === 0) {
      throw new Error(`${target.integration.name} declares no supported hook kinds`)
    }
    return supported[0]
  }
  if (!supported.includes(fromFlag)) {
    console.error(`Unknown hook type '${fromFlag}' for ${target.integration.name}. Available: ${supported.join(', ')}`)
    process.exit(1)
  }
  return fromFlag
}

/**
 * `mementos integration hook <enable|disable|status> <name> [--type=...]`.
 *
 * The integration name is required — a hook belongs to one specific client, and several
 * clients are hook-capable, so there is no sensible default to pick.
 */
async function runIntegrationHook(args: string[]): Promise<void> {
  const [verb, name] = args
  const capable = await findHookCapable()
  if (capable.length === 0) {
    console.error('No registered integration supports hooks.')
    process.exit(1)
  }
  const usage = (): never => {
    console.error('Usage: mementos integration hook enable | disable | status <name> [--type=auto-retrieve|pre-compact]')
    console.error(`Hook-capable integrations: ${capable.map(c => c.name).join(', ')}`)
    process.exit(1)
  }
  if (verb !== 'enable' && verb !== 'disable' && verb !== 'status') usage()
  if (!name) usage()
  const target = capable.find(c => c.name === name)
  if (!target) {
    console.error(`Integration '${name}' does not support hooks. Hook-capable: ${capable.map(c => c.name).join(', ')}`)
    process.exit(1)
  }
  const kind = resolveHookKind(target)

  if (verb === 'enable') {
    const machine = await readMachineConfigOrExit()

    // Will the hook subprocess be able to read the key when it fires? Each provider's
    // checkReachable owns the policy (keychain throws with remediation; env warns).
    const keyProvider = await buildKeyProvider(machine)
    try {
      await keyProvider.checkReachable?.()
    } catch (e) {
      console.error((e as Error).message)
      process.exit(1)
    }

    await target.integration.hooks.enableHook(kind)
    const blurb = kind === 'auto-retrieve'
      ? `auto-retrieve memories before each ${target.integration.name} message`
      : `snapshot the conversation before ${target.integration.name} compacts long context`
    console.log(`Hook enabled (${kind}) for ${target.integration.name} — mementos will ${blurb}.`)
    console.log(`Disable anytime with: mementos integration hook disable ${name} --type=${kind}`)
  } else if (verb === 'disable') {
    await target.integration.hooks.disableHook(kind)
    console.log(`Hook disabled (${kind}) for ${target.integration.name}.`)
  } else {
    const enabled = await target.integration.hooks.isHookEnabled(kind)
    console.log(`${target.integration.name} ${kind} hook: ${enabled ? 'enabled' : 'disabled'}`)
  }
}

export async function runIntegration(subcommand: string | undefined, args: string[]): Promise<void> {
  if (subcommand === 'hook') return runIntegrationHook(args)

  const integrationReg = await loadIntegrations()

  if (subcommand === 'configure') {
    // Re-run the integration selection + setupAtInit loop without going through
    // full --reinit. Currently-installed clients are pre-checked, unchecking
    // uninstalls, checking installs. Selection-time tips and per-integration
    // progress fire the same way they do in `mementos init`.
    const { CliInitContext } = await import('../init-context.js')
    const { setupIntegrations } = await import('./init.js')
    await setupIntegrations(new CliInitContext(), integrationReg)
    return
  }

  if (subcommand === 'list') {
    if (integrationReg.size === 0) {
      console.log('No integrations registered.')
      return
    }
    // Surface isInstalled errors rather than swallowing them — masking them as
    // "not installed" would confuse the next `enable` step.
    for (const [name, impl] of integrationReg) {
      const integration = impl.create()
      try {
        const installed = await integration.isInstalled()
        console.log(`${name}: ${installed ? 'installed' : 'not installed'}  (${integration.name})`)
      } catch (e) {
        console.log(`${name}: error  (${integration.name}): ${(e as Error).message}`)
      }
    }
    return
  }

  if (subcommand === 'enable' || subcommand === 'disable') {
    const name = args[0]
    if (!name) {
      console.error(`Usage: mementos integration ${subcommand} <name>`)
      console.error(`Available: ${[...integrationReg.keys()].join(', ') || '(none)'}`)
      process.exit(1)
    }
    const impl = integrationReg.get(name)
    if (!impl) {
      console.error(`Unknown integration: '${name}'. Available: ${[...integrationReg.keys()].join(', ') || '(none)'}`)
      process.exit(1)
    }
    const integration = impl.create()

    if (subcommand === 'enable') {
      try {
        await integration.install()
        console.log(`Installed ${integration.name}.`)
        // Match the init flow's end-of-setup hint (init.ts) so post-init `integration enable`
        // doesn't leave the user wondering whether anything else is needed.
        console.log(`Open ${integration.name} — mementos will start automatically when it connects.`)
        console.log(`Verify with: mementos doctor   (the integration line should read "${name}: installed").`)
      } catch (e) {
        console.error(`Failed to install ${integration.name}: ${(e as Error).message}`)
        process.exit(1)
      }
    } else {
      await integration.uninstall()
      console.log(`Uninstalled ${integration.name}`)
    }
    return
  }

  console.error('Usage: mementos integration list | enable <name> | disable <name> | configure | hook <enable|disable|status> <name>')
  process.exit(1)
}
