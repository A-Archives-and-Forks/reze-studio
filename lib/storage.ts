// Every localStorage/IndexedDB key this app owns, versioned in one place.
//
// Browser storage outlives releases: a draft or a model upload written by an
// older build sits there forever, and the code that reads it has long since
// changed shape. Rather than teach every reader to recognise and migrate every
// past shape, the keys carry the version that wrote them — a new version
// simply does not see the old data, and the old data ages out.

export const STORAGE_VERSION = "1"

/** `reze-studio.<name>.<version>` — the only way a key should be spelled. */
export function storageKey(name: string): string {
  return `reze-studio.${name}.${STORAGE_VERSION}`
}
