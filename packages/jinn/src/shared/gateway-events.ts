/**
 * Gateway-facing view of the neutral wire protocol.
 *
 * The CLI build replaces this module's generated declaration with the complete
 * neutral declaration so the published package remains self-contained while
 * source builds still compile against the single workspace contract.
 */
export type {
  CompanyChangedEvent,
  GatewayEmit,
  GatewayEvent,
  GatewayEventMap,
  GatewayEventName,
} from "@jinn/gateway-events";
