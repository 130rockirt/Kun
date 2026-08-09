export {
  ExtensionMediaProtocolError,
  KUN_MEDIA_PRIVILEGED_SCHEME,
  KUN_MEDIA_SCHEME,
  registerKunExtensionPlatformSchemesAsPrivileged,
  registerKunMediaSchemeAsPrivileged,
  type ExtensionMediaLease,
  type ExtensionMediaLeaseInput,
  type ExtensionMediaProtocolOptions,
  type ParsedMediaByteRange
} from './extension-media-protocol-types'
export { ExtensionMediaProtocolRegistry } from './extension-media-protocol-registry'
export {
  parseKunMediaUrl,
  parseMediaByteRange
} from './extension-media-protocol-utils'
