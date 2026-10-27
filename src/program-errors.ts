/**
 * Plain-language program errors for the site's visitors. A failed simulation or send reports
 * a code ("custom program error: 0x1776", {"Custom":6014}); each Anchor program numbers its own
 * errors from 6000, so the code means something only together with the program that failed.
 * explainError reads that from the logs: Anchor's own "Error Code: X. … Error Message: …" line
 * first (it covers any Anchor program, XDEX's too), else the code in the program's table
 * below (the #[msg] texts of lp-locker/programs/*; test/program-errors.test.ts keeps them in
 * step). The error's name stays in brackets so a page can still recognise it.
 */

export type ProgramKind = "vault" | "curve" | "locker";

/** [name, message] in declaration order (code = 6000 + index), from each program's error enum. */
export const PROGRAM_ERRORS: Record<ProgramKind, readonly (readonly [string, string])[]> = {
  vault: [
    ["BadMint", "Mint must be a Token-2022 tax token with only transfer-fee/metadata extensions, no freeze authority and a 0.02-99.99% fee"],
    ["BadAuthority", "Fee config authority must be None, the withdraw authority must be the vault's auth, and the creator (or an atomic hand-over) must create the vault"],
    ["BadPool", "Pool must be this mint's XDEX TOKEN/wXNT pool"],
    ["BadLock", "Lock must be the lp_locker lock of this NFT for this pool"],
    ["BadSplit", "Split must be burn <= 50%, LP <= 50%, burn + LP <= 55%"],
    ["NotPublisher", "Signer is not the vault's publisher"],
    ["NotGuardian", "Signer is not the vault's guardian"],
    ["StaleEpoch", "List epoch must increase"],
    ["TotalDecreased", "List total can't go down"],
    ["OverFunded", "List total is more than the holders' share has received"],
    ["NoPendingList", "No pending list"],
    ["BadProof", "Merkle proof doesn't match the active list"],
    ["NothingToCollect", "No tax to collect"],
    ["NothingToPay", "Nothing owed to this wallet"],
    ["TooSmall", "Amount too small"],
    ["Insolvent", "The vault would not cover what it owes"],
    ["MathOverflow", "Math overflow"],
    ["WrongAccount", "Wrong account"],
    ["OneSellPerSlot", "Only one sale per slot"],
    ["WrongVersion", "Wrong vault version (run upgrade_vault on a v1/v2 vault; it can't run twice)"],
    ["TooManyCancels", "The guardian can't cancel more lists in a row until one goes live"],
    ["BadRewardMint", "Reward mint must be the vault's reward token, without a transfer fee"],
    ["PublisherActive", "The publisher has published recently; the guardian can't appoint a new one yet"],
    ["FallbackNotActive", "Fallback payments start only after a long time without a published list"],
    ["PaysInToken", "This vault pays holders in its payout token: use pay_token / pay_fallback_token"],
    ["PaysInXnt", "This vault pays holders in XNT"],
    ["BadPayoutMint", "Payout token must have no freeze authority (nor, for a new vault, mint authority) and no transfer fee, hook, delegate or pause, and differ from the tax token and XNT"],
    ["BadPayoutPool", "Payout pool must be the payout token's XDEX pool against wXNT, with swaps open (and, for a new vault, at least 10 XNT)"],
    ["NotPassMode", "This vault has no holder passes"],
    ["PassModeOn", "This vault splits the holders' share with holder passes"],
    ["NotTopLevel", "Register from a top-level instruction (a wallet, not a program)"],
    ["PassBookFull", "The pass book is full"],
    ["RoundOpen", "A round is being read; try after it closes or expires"],
    ["RoundNotOpen", "No round is being read"],
    ["RoundExpired", "This round's batches ran past their window; start a new round"],
    ["BadBatch", "Batch must continue where the last one stopped, inside the book"],
    ["RoundTooSoon", "Too soon after the last round"],
    ["PotTooSmall", "Not enough waiting for holders yet"],
    ["RoundIncomplete", "Every registered pass must be read before the round closes"],
    ["PassNotEmpty", "Pass still holds enough tokens or is owed XNT"],
    ["BadIndex", "No pass at that index"],
    ["PendingList", "A list is pending"],
    ["BadPassConfig", "Bad holder-pass settings"],
    ["HoldingTooSmall", "Wallet holds too few tokens to register"],
    ["NothingToIndex", "Every pass is already in the lookup tables"],
    ["PassTablesFull", "The book's lookup tables are full"],
    ["HadList", "This vault has had a rewards list, so it can't take holder passes"],
    ["PassBookNotFull", "The pass book isn't full: register a pass instead"],
    ["EvictTooSmall", "Taking a pass's slot needs twice its balance (and the registering minimum)"],
    ["BadRoles", "Publisher and guardian must both be set and be different keys"],
  ],
  curve: [
    ["BadMint", "Mint must be a fresh 9-decimal Token-2022 mint: supply 0, mint authority = curve auth, no freeze authority, only transfer-fee and metadata extensions, metadata update authority = creator"],
    ["BadSupply", "Supply must be between 1,000 and 10,000,000,000 whole tokens"],
    ["BadTax", "Transfer fee must be 100-1000 bps with no fee-config authority"],
    ["NotTrading", "The curve is not trading"],
    ["CreatorCannotBuy", "The creator cannot buy on their own curve"],
    ["ZeroAmount", "Amount must be greater than zero"],
    ["Slippage", "Price moved beyond the slippage limit"],
    ["TooBigEarly", "Early-buy limit: in the first 2 minutes one wallet can hold at most 1% of the supply"],
    ["InsufficientBalance", "Position balance too low"],
    ["WrongStatus", "Wrong curve status for this instruction"],
    ["WrongAccount", "Wrong account"],
    ["MathOverflow", "Math overflow"],
    ["InsufficientReserve", "Curve auth would not cover the open positions' deposits; top it up and retry"],
    ["BadTarget", "Graduation target must be 500, 1,000, 3,000, 5,000 or 10,000 XNT (the testnet build also takes 10 and 20)"],
    ["EarlyWindowFull", "Early-buy limit: in the first 2 minutes all buyers together can take at most 10% of the supply"],
    ["OneBuyPerTransaction", "In the first 2 minutes a transaction can carry only one buy, sent directly to the curve"],
    ["BadWithdrawAuthority", "The token's tax must be withdrawable only by a tax vault program's auth PDA"],
    ["XdexClosed", "The XDEX fee tier for graduation doesn't exist or doesn't accept new pools"],
    ["RefundNotOpen", "Refunds open only after the curve has waited 7 days for its pool"],
  ],
  locker: [
    ["ZeroAmount", "Amount must be greater than zero"],
    ["WrongPoolAccount", "Account does not belong to this XDEX pool"],
    ["EmptyPool", "Pool has no liquidity"],
    ["BadNftMint", "NFT mint must be fresh: decimals 0, supply 0, mint authority = locker, no freeze authority, metadata extensions only"],
    ["NotNftHolder", "Signer does not hold the lock NFT"],
    ["NoFeesYet", "No trading fees to collect yet"],
    ["PoolWithdrawPaused", "Pool withdrawals are paused"],
    ["PrincipalViolated", "Collect would touch the locked principal"],
    ["MathOverflow", "Math overflow"],
    ["UnlockInPast", "Unlock time must be in the future"],
    ["StillLocked", "This lock has not reached its unlock time"],
    ["NothingToClaim", "Nothing has vested yet"],
    ["VestingFull", "Too many vesting deposits pending; claim first"],
    ["NotTaxToken", "Not a Token-2022 tax token"],
    ["NotTokenDistributor", "Signer is not this token's distributor (its withdraw-withheld authority)"],
    ["StaleEpoch", "Epoch must increase"],
    ["RewardsDecreased", "Total rewards can't go down"],
    ["NotPassHolder", "Signer does not hold this pass"],
    ["WrongPass", "Pass belongs to a different token"],
    ["BadProof", "Merkle proof doesn't match the current root"],
    ["PoolUnderfunded", "The pool doesn't hold enough to pay this claim"],
  ],
};

/** Wording for the errors visitors actually run into (the program's own text otherwise). */
const PLAIN: Record<string, string> = {
  "vault:TooSmall": "Not enough has built up for this step yet; try again later.",
  "vault:NothingToCollect": "No tax is waiting to be collected right now.",
  "vault:NothingToPay": "Nobody is owed a payout right now.",
  "vault:OneSellPerSlot": "Someone else just ran this step; wait a few seconds and try again.",
  "vault:NotGuardian": "Only the token's creator can do this.",
  "vault:WrongVersion": "This vault needs an upgrade first; the site does it within a few minutes.",
  "vault:RoundOpen": "A holder-pass round is being read right now; it finishes within a minute.",
  "vault:RoundTooSoon": "The last holder-pass round was too recent; the next one can run soon.",
  "vault:PotTooSmall": "Not enough XNT is waiting for a holder-pass round yet.",
  "vault:RoundExpired": "The round's time window ran out before it closed. Nothing is lost; run it again.",
  "vault:PassBookFull": "All 256 holder passes are taken.",
  "vault:HoldingTooSmall": "This wallet holds too few tokens to register a pass.",
  "vault:PassNotEmpty": "That pass is still owed XNT or its wallet holds enough, so it stays.",
  "curve:Slippage": "The price moved while you were signing. Try again, or allow more slippage.",
  "curve:NotTrading": "This curve isn't trading right now (it has filled or graduated).",
  "curve:InsufficientBalance": "You don't hold that many tokens on this curve.",
  "curve:CreatorCannotBuy": "The creator can't buy on their own curve.",
  "locker:NotNftHolder": "This wallet doesn't hold the lock NFT.",
  // XDEX (its errors arrive through Anchor's log line).
  "*:ExceededSlippage": "The price moved while you were signing. Try again, or allow more slippage.",
};

/**
 * A visitor-facing version of a transaction error, or the message unchanged when it names no
 * program error. `programs` maps this site's program ids to their kind.
 */
export function explainError(message: string, programs: ReadonlyMap<string, ProgramKind>): string {
  if (/insufficient (lamports|funds)|Attempt to debit an account but found no record of a prior credit/i.test(message)) {
    return "This wallet doesn't have enough XNT for this, including the network fee.";
  }
  if (/Blockhash not found|block height exceeded|TransactionExpired/i.test(message)) {
    return "The transaction expired before it landed. Please try again.";
  }
  const failed = /Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: custom program error: 0x([0-9a-f]+)/i.exec(message);
  const kind = failed ? programs.get(failed[1]) : undefined;
  const anchor = /Error Code: (\w+)\. Error Number: (\d+)\. Error Message: ([^|"]*?)\.?(?:"|\s*\||\s*$)/.exec(message);
  if (anchor) return `${PLAIN[`${kind ?? "*"}:${anchor[1]}`] ?? PLAIN[`*:${anchor[1]}`] ?? `${anchor[3].trim()}.`} (${anchor[1]})`;
  if (!kind) return message;
  const row = PROGRAM_ERRORS[kind][parseInt(failed![2], 16) - 6000];
  if (!row) return message;
  return `${PLAIN[`${kind}:${row[0]}`] ?? `${row[1]}.`} (${row[0]})`;
}
