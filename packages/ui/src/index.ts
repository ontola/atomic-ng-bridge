/**
 * `@tomic/ng-bridge-react`: the NextGraph mirror as one component.
 *
 * An Atomic app adds a dependency and one line:
 *
 * ```tsx
 * <NgBridgeBadge store={store} />
 * ```
 *
 * It renders nothing, and dynamically imports nothing, unless the mirror is
 * enabled with `?ngbridge=1`. Everything NextGraph-related lives in this
 * package and its two siblings, so the host app carries no NextGraph code of
 * its own — that containment is deliberate, see PLAN.md section 8 (M4).
 */

export * from './NgBridgeBadge.js';
export * from './useNgBridge.js';
export * from './attachNgBridge.js';
export * from './atomicAgent.js';
export * from './NgSignIn.js';
export * from './NgSyncPanel.js';
export * from './signIn.js';
export * from './ngSession.js';
export * from './walletStorage.js';
export * from './mirrorPreference.js';
export * from './documentMemory.js';
export * from './walletPassword.js';
export * from './passkey.js';
export { ngStatus } from './status.js';
