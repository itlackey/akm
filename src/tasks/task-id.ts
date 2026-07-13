// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { UsageError } from "../core/errors";

const VALID_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TASK_FILE_SUFFIX_RE = /\.(?:yml|yaml)$/i;
const WINDOWS_RESERVED_DEVICE_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

const WINDOWS_TASK_PATH_MAX_LENGTH = 238;
const WINDOWS_TASK_FOLDER_PREFIX_LENGTH = "\\akm\\".length;
const PORTABLE_FILENAME_COMPONENT_MAX_LENGTH = 255;
const LAUNCHD_FILENAME_OVERHEAD = "com.akm.task.".length + ".plist".length;
const TASK_FILENAME_OVERHEAD = ".yml".length;
const SCHTASKS_TEMP_FILENAME_OVERHEAD = "akm-task-".length + "-".length + 13 + ".xml".length;

export const MAX_PORTABLE_TASK_ID_LENGTH = Math.min(
  WINDOWS_TASK_PATH_MAX_LENGTH - WINDOWS_TASK_FOLDER_PREFIX_LENGTH,
  PORTABLE_FILENAME_COMPONENT_MAX_LENGTH - LAUNCHD_FILENAME_OVERHEAD,
  PORTABLE_FILENAME_COMPONENT_MAX_LENGTH - TASK_FILENAME_OVERHEAD,
  PORTABLE_FILENAME_COMPONENT_MAX_LENGTH - SCHTASKS_TEMP_FILENAME_OVERHEAD,
);

export function validateTaskId(id: string): string {
  if (!id) {
    throw new UsageError("Task id must be non-empty.", "MISSING_REQUIRED_ARGUMENT");
  }
  if (!VALID_TASK_ID_RE.test(id)) {
    throw new UsageError(
      `Task id "${id}" is invalid. Use letters, digits, dots, underscores, and dashes only.`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (id.length > MAX_PORTABLE_TASK_ID_LENGTH) {
    throw new UsageError(
      `Task id "${id}" is invalid. Use at most ${MAX_PORTABLE_TASK_ID_LENGTH} characters for all supported schedulers.`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (TASK_FILE_SUFFIX_RE.test(id)) {
    throw new UsageError(
      `Task id "${id}" is invalid. Use the bare task id without a .yml or .yaml suffix.`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (WINDOWS_RESERVED_DEVICE_RE.test(id)) {
    throw new UsageError(
      `Task id "${id}" uses a reserved Windows device name. Choose a different task id.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return id;
}

export function normaliseTaskId(raw: string): string {
  // Keep accepting old task-file suffixes at the CLI boundary, but never
  // normalize filesystem-derived ids into a different filename.
  return validateTaskId(raw.trim().replace(/\.(yml|md)$/, ""));
}
