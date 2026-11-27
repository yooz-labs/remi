// #1170 proof adapter: the daemon owns the sole settlement implementation.
export {
  JOURNAL_READ_MAX_BYTES,
  type JournalRead,
  type JournalWriter,
  SETTLEMENT_STAGES,
  type SettlementStage,
  beginJournal,
  settleJournal,
} from '../../packages/daemon/src/tunnel/journal-settlement';
