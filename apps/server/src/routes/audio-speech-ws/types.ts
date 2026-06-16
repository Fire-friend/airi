import type { ConfigKVService } from '../../services/adapters/config-kv'
import type { ProductEventService } from '../../services/domain/product-events'
import type { RequestLogService } from '../../services/domain/request-log'
import type { EnvelopeCrypto } from '../../utils/envelope-crypto'

/**
 * Dependencies required by the streaming speech websocket proxy.
 */
export interface AudioSpeechWsHandlersOptions {
  /** Reads upstream websocket URL and encrypted API keys. */
  configKV: ConfigKVService
  /** Decrypts the selected upstream API key before the websocket handshake. */
  envelopeCrypto: EnvelopeCrypto
  /** Persists request accounting after a stream finishes. */
  requestLogService: RequestLogService
  /** Writes first-party product analytics for distinct-user aggregation. */
  productEventService: ProductEventService
}
