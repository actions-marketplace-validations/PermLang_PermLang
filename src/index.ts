// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// PermLang's programmatic API. The CLI (`permlang`) is built on these.

export {
  checkFiles,
  checkProject,
  checkTsConfig,
  STRICTNESS_LEVELS,
  UNMAPPED_POLICIES,
  type CheckOptions,
  type Diagnostic,
  type FunctionReport,
  type Report,
  type Strictness,
  type UnmappedPolicy,
  type UnsafeReport,
} from "./check.js";
export { AdapterError, parseManifest, type Adapter } from "./adapters.js";
export { formatCapability, parsePermList, covers, type Capability } from "./capability.js";
export { buildLock, diffLocks, parseLock, serializeLock, LockError, type LockDiff, type LockFile } from "./lock.js";
export { formatDiffMarkdown, formatDiffText, type ViaPaths } from "./diff.js";
export { formatText, toJson } from "./report.js";
