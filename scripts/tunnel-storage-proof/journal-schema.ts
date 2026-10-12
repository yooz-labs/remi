// #1443/#1170 proof adapter; identifiers carry no transfer authority.
export {
  type JournalBinding,
  type JournalLease,
  MARKER_ALLOWANCE,
  type MarkerKind,
  type MarkerWitness,
  sameLease,
  sameWitnesses,
  validBinding,
  validWitnesses,
} from '../../packages/daemon/src/tunnel/journal-schema';
