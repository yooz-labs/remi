/// A loopback port for tests whose endpoint must never reach a live remi.
///
/// 18765 is the default hub port on a developer Mac, where it is usually the owner's real hub or a
/// session daemon, and a store started against it can connect and leave a pending key candidate
/// there (#1826). Port 9 is the TCP discard service: macOS ships it disabled, remi's hub range
/// (18765 to 18784) and daemon ports never include it, and no test binds it, so on a stock Mac
/// nothing listens there and a connection attempt is refused at once. Use this for every loopback endpoint a test does not
/// serve itself; tests that need a listener bind port 0 and use the port they are given.
let closedLoopbackPort = 9
