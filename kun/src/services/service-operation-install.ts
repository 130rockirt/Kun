/**
 * Installs extracted service methods with the same prototype descriptor shape
 * as native class methods. Keeping the installer in one place lets large
 * services organize operations by responsibility without changing instances.
 */
export function installServiceOperations(
  prototype: object,
  ...operationGroups: readonly object[]
): void {
  for (const operations of operationGroups) {
    for (const key of Reflect.ownKeys(operations)) {
      const descriptor = Object.getOwnPropertyDescriptor(operations, key)
      if (!descriptor) continue
      const installed = 'value' in descriptor
        ? { ...descriptor, configurable: true, enumerable: false, writable: true }
        : { ...descriptor, configurable: true, enumerable: false }
      Object.defineProperty(prototype, key, installed)
    }
  }
}
