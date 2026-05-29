import type { ClientIntegration } from '../interface.js'
import type { InitContext } from '../../core/init-context/interface.js'
import { withInstallShell } from './install-shell.js'

/** setupAtInit for integrations with no prompts after install. See `withInstallShell`. */
export function defaultSetupAtInit(
  factory: () => ClientIntegration,
): (ctx: InitContext) => Promise<void> {
  return ctx => {
    const i = factory()
    return withInstallShell(
      { name: i.name, install: () => i.install(), isInstalled: () => i.isInstalled() },
      ctx,
    )
  }
}
