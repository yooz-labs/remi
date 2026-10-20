// #1170 proof adapter: the daemon owns the sole settlement implementation.
export {
  type JournalRead,
  type JournalWriter,
  SETTLEMENT_STAGES,
  type SettlementStage,
  beginJournal,
  settleJournal,
} from '../../packages/daemon/src/tunnel/journal-settlement';
