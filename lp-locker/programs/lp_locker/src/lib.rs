//! Locks XDEX (Raydium CP-swap fork) LP tokens forever behind a 1-of-1 NFT.
//!
//! * `lock` moves LP tokens into a vault owned by this program and mints a Token-2022
//!   NFT (supply 1, mint authority revoked) to the locker. There is no instruction that
//!   returns the LP tokens: the principal can never be withdrawn, by anyone.
//! * `lock_timed` does the same but records an unlock time in a separate `LockSchedule`
//!   account. After that time, `unlock` returns all the LP tokens to the NFT holder and
//!   burns the NFT. A lock made with `lock` has no schedule, and a schedule can only be
//!   created by `lock_timed` in the same instruction that creates its lock, so a forever
//!   lock can never become unlockable.
//! * `collect_fees` lets whoever holds the NFT withdraw only the trading fees the
//!   locked liquidity has earned.
//! * Creator rewards: anyone (in practice the token's distributor) can `deposit_reward`
//!   tokens into a `RewardVault` tied to a lock NFT. Each deposit vests for 7 days, and
//!   the NFT holder can then `claim_reward`. The NFT is the claim key, so selling the
//!   NFT sells the reward stream; `unlock` therefore keeps the NFT instead of burning it.
//!
//! * Holder passes (pull-based holder rewards): a token's distributor creates one
//!   `HolderPool` for its token (`init_holder_pool`; only the token's tax-withdraw
//!   authority can). Holders mint a 1-of-1 pass NFT (`mint_pass`). Each cycle the
//!   distributor posts a Merkle root of every pass's *cumulative* reward and tops the pool
//!   up to the new total in the same instruction (`set_root`), so the pool always holds
//!   everything it has promised minus what was claimed. Whoever holds a pass claims the
//!   difference between its cumulative total and what it already claimed
//!   (`claim_pass`). One root per cycle replaces one transfer per holder, so gas stays
//!   flat however many holders there are; each holder pays for their own claim.
//!
//! How fees are measured: in a constant-product pool, swaps can only grow
//! sqrt(reserve0 * reserve1), and only through trading fees. Deposits and withdrawals
//! keep sqrt(k) per LP token unchanged. So the liquidity one LP token represents is
//! `sqrt(k) / lp_supply`, and it only goes up. At lock time we record the locked
//! liquidity (`principal`, in sqrt(k) units, rounded up). Later, the locked LP is worth
//! `lp * sqrt(k) / lp_supply` (rounded down); the difference is fees, and exactly that
//! many LP tokens are withdrawn to the NFT holder. What stays in the vault is always
//! worth at least `principal`.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_lang::system_program;
use solana_sha256_hasher::hashv;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::spl_token_2022::{
    extension::{transfer_fee::TransferFeeConfig, BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    instruction::AuthorityType,
    state::Mint as MintState,
};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{
    self, Mint as NftMint, MintTo, SetAuthority, TokenAccount as NftAccount, TokenInterface, TransferChecked,
};

declare_id!("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");

#[cfg(feature = "testnet")]
pub const XDEX_PROGRAM_ID: Pubkey = pubkey!("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
#[cfg(not(feature = "testnet"))]
pub const XDEX_PROGRAM_ID: Pubkey = pubkey!("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");

pub const MEMO_PROGRAM_ID: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/// Anchor discriminator of XDEX `withdraw` (verified against XDEX mainnet transactions).
const WITHDRAW_DISC: [u8; 8] = [0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22];
/// Anchor discriminator of XDEX `PoolState` (sha256("account:PoolState")[..8]).
const POOL_DISC: [u8; 8] = [0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46];
const POOL_LEN: usize = 637;
/// How long each creator-reward deposit vests before the NFT holder can claim it, and
/// the bucket size deposits are grouped into (deposits in one bucket vest together).
#[cfg(not(feature = "short-vest"))]
pub const VEST_SECONDS: i64 = 7 * 86_400;
#[cfg(not(feature = "short-vest"))]
pub const VEST_BUCKET: i64 = 86_400;
/// Local testing only: vest in seconds instead of days.
#[cfg(feature = "short-vest")]
pub const VEST_SECONDS: i64 = 30;
#[cfg(feature = "short-vest")]
pub const VEST_BUCKET: i64 = 10;
pub const TRANCHES: usize = 10;

/// Pool status bit 1 = withdrawals paused.
const STATUS_WITHDRAW_PAUSED: u8 = 1 << 1;

#[program]
pub mod lp_locker {
    use super::*;

    /// Lock `amount` LP tokens forever and mint the 1-of-1 fee NFT to `owner`.
    ///
    /// `nft_mint` must be a fresh Token-2022 mint (decimals 0, supply 0, mint authority
    /// = owner, no freeze authority) carrying only metadata extensions. This
    /// instruction mints the single NFT and revokes the mint authority.
    pub fn lock(ctx: Context<LockLp>, amount: u64) -> Result<()> {
        let bumps = (ctx.bumps.lock, ctx.bumps.vault);
        lock_inner(ctx.accounts, bumps, amount)
    }

    /// Like `lock`, but the NFT holder can take the LP tokens back with `unlock` once
    /// `unlock_at` (unix seconds) has passed.
    pub fn lock_timed(ctx: Context<LockTimed>, amount: u64, unlock_at: i64) -> Result<()> {
        require!(unlock_at > Clock::get()?.unix_timestamp, LockerError::UnlockInPast);
        let bumps = (ctx.bumps.base.lock, ctx.bumps.base.vault);
        lock_inner(&mut ctx.accounts.base, bumps, amount)?;
        let schedule = &mut ctx.accounts.schedule;
        schedule.lock = ctx.accounts.base.lock.key();
        schedule.unlock_at = unlock_at;
        schedule.bump = ctx.bumps.schedule;
        emit!(TimedLock { lock: schedule.lock, unlock_at });
        Ok(())
    }

    /// After a timed lock expires: send every LP token in the vault to the NFT holder and
    /// close the lock, schedule and vault (rent goes to the holder). The NFT is kept: it
    /// stays the key for claiming creator rewards.
    pub fn unlock(ctx: Context<Unlock>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.schedule.unlock_at, LockerError::StillLocked);
        let a = &ctx.accounts;
        let nft_mint = a.lock.nft_mint;
        let seeds: &[&[u8]] = &[b"lock", nft_mint.as_ref(), &[a.lock.bump]];
        let amount = a.vault.amount;
        if amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    a.token_program.to_account_info(),
                    Transfer {
                        from: a.vault.to_account_info(),
                        to: a.holder_lp.to_account_info(),
                        authority: a.lock.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
            )?;
        }
        token::close_account(CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            CloseAccount {
                account: a.vault.to_account_info(),
                destination: a.holder.to_account_info(),
                authority: a.lock.to_account_info(),
            },
            &[seeds],
        ))?;
        emit!(Unlocked { lock: a.lock.key(), holder: a.holder.key(), lp_amount: amount });
        Ok(()) // `close = holder` closes the lock and schedule accounts
    }

    /// Create the creator-reward vault for a lock NFT and a reward token (e.g. USDC).
    /// Anyone may pay for it; it only accepts NFTs that belong to an lp_locker lock.
    pub fn init_reward_vault(ctx: Context<InitRewardVault>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.nft_mint = ctx.accounts.nft_mint.key();
        v.reward_mint = ctx.accounts.reward_mint.key();
        v.claimable = 0;
        v.total_deposited = 0;
        v.total_claimed = 0;
        v.tranches = [Tranche::default(); TRANCHES];
        v.bump = ctx.bumps.vault;
        v.tokens_bump = ctx.bumps.vault_tokens;
        Ok(())
    }

    /// Add `amount` reward tokens. They vest for VEST_SECONDS (grouped into buckets).
    pub fn deposit_reward(ctx: Context<DepositReward>, amount: u64) -> Result<()> {
        require!(amount > 0, LockerError::ZeroAmount);
        let a = &ctx.accounts;
        token_interface::transfer_checked(
            CpiContext::new(
                a.token_program.to_account_info(),
                TransferChecked {
                    from: a.depositor_tokens.to_account_info(),
                    mint: a.reward_mint.to_account_info(),
                    to: a.vault_tokens.to_account_info(),
                    authority: a.depositor.to_account_info(),
                },
            ),
            amount,
            a.reward_mint.decimals,
        )?;
        let now = Clock::get()?.unix_timestamp;
        let v = &mut ctx.accounts.vault;
        v.add(amount, now)?;
        v.total_deposited = v.total_deposited.checked_add(amount).ok_or(LockerError::MathOverflow)?;
        emit!(RewardDeposited { vault: v.key(), amount, unlock_at: v.bucket_unlock(now) });
        Ok(())
    }

    /// Send every vested reward to the NFT holder's token account.
    pub fn claim_reward(ctx: Context<ClaimReward>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let amount = {
            let v = &mut ctx.accounts.vault;
            v.release(now)?;
            v.claimable
        };
        require!(amount > 0, LockerError::NothingToClaim);
        let a = &ctx.accounts;
        let nft = a.vault.nft_mint;
        let reward = a.vault.reward_mint;
        let seeds: &[&[u8]] = &[b"reward", nft.as_ref(), reward.as_ref(), &[a.vault.bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                TransferChecked {
                    from: a.vault_tokens.to_account_info(),
                    mint: a.reward_mint.to_account_info(),
                    to: a.holder_tokens.to_account_info(),
                    authority: a.vault.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            a.reward_mint.decimals,
        )?;
        let v = &mut ctx.accounts.vault;
        v.claimable = 0;
        v.total_claimed = v.total_claimed.checked_add(amount).ok_or(LockerError::MathOverflow)?;
        emit!(RewardClaimed { vault: v.key(), holder: ctx.accounts.holder.key(), amount });
        Ok(())
    }

    /// Withdraw the trading fees earned by the locked liquidity to the NFT holder's
    /// token accounts. `minimum_token_0/1` guard against a manipulated pool ratio.
    pub fn collect_fees(ctx: Context<CollectFees>, minimum_token_0: u64, minimum_token_1: u64) -> Result<()> {
        let a = &ctx.accounts;
        let pool = PoolView::read(&a.pool)?;
        require!(pool.status & STATUS_WITHDRAW_PAUSED == 0, LockerError::PoolWithdrawPaused);
        require_keys_eq!(pool.lp_mint, a.lp_mint.key(), LockerError::WrongPoolAccount);
        require_keys_eq!(pool.mint0, a.vault_0_mint.key(), LockerError::WrongPoolAccount);
        require_keys_eq!(pool.mint1, a.vault_1_mint.key(), LockerError::WrongPoolAccount);
        let (sqrt_k, supply) = pool.liquidity(&a.token_0_vault, &a.token_1_vault)?;

        let fee_lp = fee_lp(a.vault.amount, a.lock.principal, sqrt_k, supply)?;
        require!(fee_lp > 0, LockerError::NoFeesYet);

        let nft_mint = a.lock.nft_mint;
        let seeds: &[&[u8]] = &[b"lock", nft_mint.as_ref(), &[a.lock.bump]];
        let mut data = Vec::with_capacity(32);
        data.extend_from_slice(&WITHDRAW_DISC);
        data.extend_from_slice(&fee_lp.to_le_bytes());
        data.extend_from_slice(&minimum_token_0.to_le_bytes());
        data.extend_from_slice(&minimum_token_1.to_le_bytes());
        let ix = Instruction {
            program_id: XDEX_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(a.lock.key(), true),
                AccountMeta::new_readonly(a.xdex_authority.key(), false),
                AccountMeta::new(a.pool.key(), false),
                AccountMeta::new(a.vault.key(), false),
                AccountMeta::new(a.holder_token_0.key(), false),
                AccountMeta::new(a.holder_token_1.key(), false),
                AccountMeta::new(a.token_0_vault.key(), false),
                AccountMeta::new(a.token_1_vault.key(), false),
                AccountMeta::new_readonly(a.token_program.key(), false),
                AccountMeta::new_readonly(a.token_2022_program.key(), false),
                AccountMeta::new_readonly(a.vault_0_mint.key(), false),
                AccountMeta::new_readonly(a.vault_1_mint.key(), false),
                AccountMeta::new(a.lp_mint.key(), false),
                AccountMeta::new_readonly(a.memo_program.key(), false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                a.lock.to_account_info(),
                a.xdex_authority.to_account_info(),
                a.pool.to_account_info(),
                a.vault.to_account_info(),
                a.holder_token_0.to_account_info(),
                a.holder_token_1.to_account_info(),
                a.token_0_vault.to_account_info(),
                a.token_1_vault.to_account_info(),
                a.token_program.to_account_info(),
                a.token_2022_program.to_account_info(),
                a.vault_0_mint.to_account_info(),
                a.vault_1_mint.to_account_info(),
                a.lp_mint.to_account_info(),
                a.memo_program.to_account_info(),
                a.xdex_program.to_account_info(),
            ],
            &[seeds],
        )?;

        // Defence in depth: what remains must still cover the principal.
        let vault = &mut ctx.accounts.vault;
        vault.reload()?;
        let pool_after = PoolView::read(&ctx.accounts.pool)?;
        let (sqrt_k_after, supply_after) =
            pool_after.liquidity(&ctx.accounts.token_0_vault, &ctx.accounts.token_1_vault)?;
        let remaining = mul_div_floor(vault.amount as u128, sqrt_k_after, supply_after)?;
        require!(remaining >= ctx.accounts.lock.principal, LockerError::PrincipalViolated);

        let lock = &mut ctx.accounts.lock;
        lock.fee_lp_collected = lock.fee_lp_collected.checked_add(fee_lp).ok_or(LockerError::MathOverflow)?;
        emit!(FeesCollected {
            lock: lock.key(),
            holder: ctx.accounts.holder.key(),
            fee_lp,
            remaining_lp: ctx.accounts.vault.amount,
        });
        Ok(())
    }

    // ---------- Holder passes ----------

    /// Create the holder-reward pool for a Token-2022 tax token. Only the token's
    /// withdraw-withheld authority (its distributor wallet) can, so nobody can squat a
    /// token's pool or post roots for it.
    pub fn init_holder_pool(ctx: Context<InitHolderPool>) -> Result<()> {
        let mint_info = ctx.accounts.token_mint.to_account_info();
        require_keys_eq!(*mint_info.owner, anchor_spl::token_2022::ID, LockerError::NotTaxToken);
        {
            let data = mint_info.try_borrow_data()?;
            let state = StateWithExtensions::<MintState>::unpack(&data)?;
            let fee = state.get_extension::<TransferFeeConfig>().map_err(|_| error!(LockerError::NotTaxToken))?;
            let withdraw: Option<Pubkey> = fee.withdraw_withheld_authority.into();
            require!(withdraw == Some(ctx.accounts.authority.key()), LockerError::NotTokenDistributor);
        }
        let p = &mut ctx.accounts.holder_pool;
        p.token_mint = ctx.accounts.token_mint.key();
        p.authority = ctx.accounts.authority.key();
        p.root = [0; 32];
        p.epoch = 0;
        p.total_funded = 0;
        p.total_claimed = 0;
        p.passes = 0;
        p.bump = ctx.bumps.holder_pool;
        emit!(HolderPoolCreated { pool: p.key(), token_mint: p.token_mint, authority: p.authority });
        Ok(())
    }

    /// Publish a new Merkle root of every pass's cumulative reward, and top the pool up so
    /// it holds `total_rewards` in all (minus what's been claimed). `total_rewards` can
    /// only grow and `epoch` must increase, so an old root can't be replayed.
    pub fn set_root(ctx: Context<SetRoot>, root: [u8; 32], epoch: u64, total_rewards: u64) -> Result<()> {
        let (prev_epoch, funded) = (ctx.accounts.holder_pool.epoch, ctx.accounts.holder_pool.total_funded);
        require!(epoch > prev_epoch, LockerError::StaleEpoch);
        require!(total_rewards >= funded, LockerError::RewardsDecreased);
        let add = total_rewards - funded;
        if add > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: ctx.accounts.holder_pool.to_account_info(),
                    },
                ),
                add,
            )?;
        }
        let p = &mut ctx.accounts.holder_pool;
        p.root = root;
        p.epoch = epoch;
        p.total_funded = total_rewards;
        emit!(RootSet { pool: p.key(), epoch, root, total_rewards, added: add });
        Ok(())
    }

    /// Mint a 1-of-1 holder pass for this pool's token to `owner`. Like the lock NFT,
    /// `pass_mint` must be a fresh Token-2022 mint (decimals 0, supply 0, mint authority =
    /// owner, no freeze authority, metadata extensions only); this mints the single token
    /// and revokes the mint authority.
    pub fn mint_pass(ctx: Context<MintPass>) -> Result<()> {
        check_nft_mint(&ctx.accounts.pass_mint.to_account_info(), &ctx.accounts.owner.key())?;
        token_interface::mint_to(
            CpiContext::new(
                ctx.accounts.token_2022_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.pass_mint.to_account_info(),
                    to: ctx.accounts.owner_pass.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            1,
        )?;
        token_interface::set_authority(
            CpiContext::new(
                ctx.accounts.token_2022_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.owner.to_account_info(),
                    account_or_mint: ctx.accounts.pass_mint.to_account_info(),
                },
            ),
            AuthorityType::MintTokens,
            None,
        )?;
        let pass = &mut ctx.accounts.pass;
        pass.token_mint = ctx.accounts.holder_pool.token_mint;
        pass.pass_mint = ctx.accounts.pass_mint.key();
        pass.minter = ctx.accounts.owner.key();
        pass.claimed = 0;
        pass.created_at = Clock::get()?.unix_timestamp;
        pass.bump = ctx.bumps.pass;
        let pool = &mut ctx.accounts.holder_pool;
        pool.passes = pool.passes.checked_add(1).ok_or(LockerError::MathOverflow)?;
        emit!(PassMinted { pass: pass.key(), pass_mint: pass.pass_mint, token_mint: pass.token_mint, owner: pass.minter });
        Ok(())
    }

    /// Whoever holds a pass claims what it has earned: its `cumulative` total (proven
    /// against the pool's current root) minus what the pass already claimed.
    pub fn claim_pass(ctx: Context<ClaimPass>, cumulative: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        require!(ctx.accounts.holder_pass.amount == 1, LockerError::NotPassHolder);
        let root = ctx.accounts.holder_pool.root;
        let leaf = pass_leaf(&ctx.accounts.pass.pass_mint, cumulative);
        require!(verify_proof(&proof, &root, leaf), LockerError::BadProof);
        let claimed = ctx.accounts.pass.claimed;
        require!(cumulative > claimed, LockerError::NothingToClaim);
        let amount = cumulative - claimed;

        let pool_info = ctx.accounts.holder_pool.to_account_info();
        let keep = Rent::get()?.minimum_balance(pool_info.data_len());
        require!(pool_info.lamports() >= keep.checked_add(amount).ok_or(LockerError::MathOverflow)?, LockerError::PoolUnderfunded);
        **pool_info.try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.holder.to_account_info().try_borrow_mut_lamports()? += amount;

        ctx.accounts.pass.claimed = cumulative;
        let pool = &mut ctx.accounts.holder_pool;
        pool.total_claimed = pool.total_claimed.checked_add(amount).ok_or(LockerError::MathOverflow)?;
        emit!(PassClaimed { pass: ctx.accounts.pass.key(), holder: ctx.accounts.holder.key(), amount, cumulative });
        Ok(())
    }
}

/// Leaf of the holder-pass tree. The domain prefix makes a leaf (50 bytes hashed) unable
/// to collide with an inner node (64 bytes hashed).
pub fn pass_leaf(pass_mint: &Pubkey, cumulative: u64) -> [u8; 32] {
    hashv(&[b"99tax-pass", pass_mint.as_ref(), &cumulative.to_le_bytes()]).to_bytes()
}

/// Sorted-pair Merkle proof: at each level hash the smaller node first.
pub fn verify_proof(proof: &[[u8; 32]], root: &[u8; 32], leaf: [u8; 32]) -> bool {
    let mut h = leaf;
    for p in proof {
        h = if h <= *p { hashv(&[&h, p]) } else { hashv(&[p, &h]) }.to_bytes();
    }
    &h == root
}

/// Shared by `lock` and `lock_timed`: move the LP into the vault, mint the NFT, revoke
/// its mint authority and record the principal.
fn lock_inner(a: &mut LockLp, bumps: (u8, u8), amount: u64) -> Result<()> {
        require!(amount > 0, LockerError::ZeroAmount);
        
        let pool = PoolView::read(&a.pool)?;
        require_keys_eq!(pool.lp_mint, a.lp_mint.key(), LockerError::WrongPoolAccount);
        let (sqrt_k, supply) = pool.liquidity(&a.token_0_vault, &a.token_1_vault)?;

        check_nft_mint(&a.nft_mint.to_account_info(), &a.owner.key())?;

        // Principal in sqrt(k) units, rounded up so fees can never dip into it.
        let principal = mul_div_ceil(amount as u128, sqrt_k, supply)?;
        require!(principal > 0, LockerError::ZeroAmount);

        token::transfer(
            CpiContext::new(
                a.token_program.to_account_info(),
                Transfer {
                    from: a.owner_lp.to_account_info(),
                    to: a.vault.to_account_info(),
                    authority: a.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        token_interface::mint_to(
            CpiContext::new(
                a.token_2022_program.to_account_info(),
                MintTo {
                    mint: a.nft_mint.to_account_info(),
                    to: a.owner_nft.to_account_info(),
                    authority: a.owner.to_account_info(),
                },
            ),
            1,
        )?;
        token_interface::set_authority(
            CpiContext::new(
                a.token_2022_program.to_account_info(),
                SetAuthority {
                    current_authority: a.owner.to_account_info(),
                    account_or_mint: a.nft_mint.to_account_info(),
                },
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        let lock = &mut a.lock;
        lock.nft_mint = a.nft_mint.key();
        lock.pool = a.pool.key();
        lock.lp_mint = a.lp_mint.key();
        lock.locker = a.owner.key();
        lock.locked_lp = amount;
        lock.principal = principal;
        lock.fee_lp_collected = 0;
        lock.locked_at = Clock::get()?.unix_timestamp;
        lock.bump = bumps.0;
        lock.vault_bump = bumps.1;

        emit!(Locked {
            lock: lock.key(),
            nft_mint: lock.nft_mint,
            pool: lock.pool,
            locker: lock.locker,
            lp_amount: amount,
            principal,
        });
        Ok(())
}

/// LP tokens worth of fees: locked value minus principal, converted back to LP.
pub fn fee_lp(locked_lp: u64, principal: u128, sqrt_k: u128, supply: u128) -> Result<u64> {
    let value = mul_div_floor(locked_lp as u128, sqrt_k, supply)?;
    if value <= principal {
        return Ok(0);
    }
    let lp = mul_div_floor(value - principal, supply, sqrt_k)?;
    u64::try_from(lp).map_err(|_| error!(LockerError::MathOverflow))
}

fn mul_div_floor(a: u128, b: u128, c: u128) -> Result<u128> {
    require!(c > 0, LockerError::MathOverflow);
    Ok(a.checked_mul(b).ok_or(LockerError::MathOverflow)? / c)
}

fn mul_div_ceil(a: u128, b: u128, c: u128) -> Result<u128> {
    require!(c > 0, LockerError::MathOverflow);
    let p = a.checked_mul(b).ok_or(LockerError::MathOverflow)?;
    Ok(p / c + u128::from(p % c != 0))
}

pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = 1u128 << ((128 - n.leading_zeros()).div_ceil(2));
    loop {
        let y = (x + n / x) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// The NFT must be a plain 1-of-1: fresh, owned by the locker, not freezable, and
/// with no extension that would let anyone else move, freeze or close it.
fn check_nft_mint(mint: &AccountInfo, owner: &Pubkey) -> Result<()> {
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data)?;
    let m = &state.base;
    require!(m.decimals == 0 && m.supply == 0, LockerError::BadNftMint);
    require!(m.mint_authority == Some(*owner).into(), LockerError::BadNftMint);
    require!(m.freeze_authority.is_none(), LockerError::BadNftMint);
    for ext in state.get_extension_types()? {
        require!(
            matches!(ext, ExtensionType::MetadataPointer | ExtensionType::TokenMetadata),
            LockerError::BadNftMint
        );
    }
    Ok(())
}

/// The parts of an XDEX PoolState this program needs (layout verified against X1 pools).
struct PoolView {
    vault0: Pubkey,
    vault1: Pubkey,
    lp_mint: Pubkey,
    mint0: Pubkey,
    mint1: Pubkey,
    status: u8,
    lp_supply: u64,
    protocol_fees: [u64; 2],
    fund_fees: [u64; 2],
}

impl PoolView {
    fn read(acc: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*acc.owner, XDEX_PROGRAM_ID, LockerError::WrongPoolAccount);
        let d = acc.try_borrow_data()?;
        require!(d.len() == POOL_LEN, LockerError::WrongPoolAccount);
        require!(d[..8] == POOL_DISC, LockerError::WrongPoolAccount);
        let key = |i: usize| Pubkey::new_from_array(d[8 + i * 32..40 + i * 32].try_into().unwrap());
        let u64_at = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
        Ok(Self {
            vault0: key(2),
            vault1: key(3),
            lp_mint: key(4),
            mint0: key(5),
            mint1: key(6),
            status: d[329],
            lp_supply: u64_at(333),
            protocol_fees: [u64_at(341), u64_at(349)],
            fund_fees: [u64_at(357), u64_at(365)],
        })
    }

    /// (sqrt(reserve0 * reserve1), pool LP supply). Reserves exclude protocol and fund
    /// fees, exactly as the pool itself prices deposits and withdrawals.
    fn liquidity(&self, v0: &AccountInfo, v1: &AccountInfo) -> Result<(u128, u128)> {
        require_keys_eq!(self.vault0, v0.key(), LockerError::WrongPoolAccount);
        require_keys_eq!(self.vault1, v1.key(), LockerError::WrongPoolAccount);
        let r0 = token_amount(v0)?
            .checked_sub(self.protocol_fees[0] + self.fund_fees[0])
            .ok_or(LockerError::MathOverflow)?;
        let r1 = token_amount(v1)?
            .checked_sub(self.protocol_fees[1] + self.fund_fees[1])
            .ok_or(LockerError::MathOverflow)?;
        require!(r0 > 0 && r1 > 0 && self.lp_supply > 0, LockerError::EmptyPool);
        Ok((isqrt(r0 as u128 * r1 as u128), self.lp_supply as u128))
    }
}

fn token_amount(acc: &AccountInfo) -> Result<u64> {
    require!(
        *acc.owner == anchor_spl::token::ID || *acc.owner == anchor_spl::token_2022::ID,
        LockerError::WrongPoolAccount
    );
    let d = acc.try_borrow_data()?;
    require!(d.len() >= 72, LockerError::WrongPoolAccount);
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

#[account]
#[derive(InitSpace)]
pub struct Lock {
    pub nft_mint: Pubkey,
    pub pool: Pubkey,
    pub lp_mint: Pubkey,
    /// Wallet that created the lock (the NFT may have moved since).
    pub locker: Pubkey,
    pub locked_lp: u64,
    /// Locked liquidity in sqrt(k) units; never withdrawn.
    pub principal: u128,
    pub fee_lp_collected: u64,
    pub locked_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(Accounts)]
pub struct LockLp<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: owner, size and discriminator checked in PoolView::read.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: must equal the pool's token 0 vault (checked in PoolView::liquidity).
    pub token_0_vault: UncheckedAccount<'info>,
    /// CHECK: must equal the pool's token 1 vault (checked in PoolView::liquidity).
    pub token_1_vault: UncheckedAccount<'info>,
    pub lp_mint: Account<'info, Mint>,
    #[account(mut, token::mint = lp_mint, token::authority = owner)]
    pub owner_lp: Account<'info, TokenAccount>,
    #[account(mut, mint::token_program = token_2022_program)]
    pub nft_mint: InterfaceAccount<'info, NftMint>,
    #[account(mut, token::mint = nft_mint, token::authority = owner, token::token_program = token_2022_program)]
    pub owner_nft: InterfaceAccount<'info, NftAccount>,
    #[account(init, payer = owner, space = 8 + Lock::INIT_SPACE, seeds = [b"lock", nft_mint.key().as_ref()], bump)]
    pub lock: Account<'info, Lock>,
    #[account(
        init, payer = owner, seeds = [b"vault", lock.key().as_ref()], bump,
        token::mint = lp_mint, token::authority = lock, token::token_program = token_program,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct LockSchedule {
    pub lock: Pubkey,
    /// Unix seconds after which the NFT holder may `unlock`.
    pub unlock_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Tranche {
    pub amount: u64,
    pub unlock_at: i64,
}

/// Creator rewards for one lock NFT in one reward token, vesting before they can be claimed.
#[account]
#[derive(InitSpace)]
pub struct RewardVault {
    pub nft_mint: Pubkey,
    pub reward_mint: Pubkey,
    /// Vested and not yet claimed.
    pub claimable: u64,
    pub total_deposited: u64,
    pub total_claimed: u64,
    /// Still vesting, grouped by unlock time.
    pub tranches: [Tranche; TRANCHES],
    pub bump: u8,
    pub tokens_bump: u8,
}

impl RewardVault {
    /// Unlock time for a deposit made at `now`: the end of its bucket plus the vesting period.
    pub fn bucket_unlock(&self, now: i64) -> i64 {
        (now / VEST_BUCKET + 1) * VEST_BUCKET + VEST_SECONDS
    }

    /// Move every tranche whose time has come into `claimable`.
    pub fn release(&mut self, now: i64) -> Result<()> {
        for t in self.tranches.iter_mut() {
            if t.amount > 0 && t.unlock_at <= now {
                self.claimable = self.claimable.checked_add(t.amount).ok_or(LockerError::MathOverflow)?;
                *t = Tranche::default();
            }
        }
        Ok(())
    }

    pub fn add(&mut self, amount: u64, now: i64) -> Result<()> {
        self.release(now)?;
        let unlock_at = self.bucket_unlock(now);
        let slot = self.tranches.iter().position(|t| t.amount > 0 && t.unlock_at == unlock_at)
            .or_else(|| self.tranches.iter().position(|t| t.amount == 0))
            .ok_or(LockerError::VestingFull)?;
        let t = &mut self.tranches[slot];
        t.amount = t.amount.checked_add(amount).ok_or(LockerError::MathOverflow)?;
        t.unlock_at = unlock_at;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitRewardVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mint::token_program = token_2022_program)]
    pub nft_mint: InterfaceAccount<'info, NftMint>,
    /// The lock this NFT belongs to (proves it's an lp_locker NFT).
    #[account(seeds = [b"lock", nft_mint.key().as_ref()], bump = lock.bump)]
    pub lock: Account<'info, Lock>,
    #[account(mint::token_program = reward_token_program)]
    pub reward_mint: InterfaceAccount<'info, NftMint>,
    #[account(
        init, payer = payer, space = 8 + RewardVault::INIT_SPACE,
        seeds = [b"reward", nft_mint.key().as_ref(), reward_mint.key().as_ref()], bump,
    )]
    pub vault: Account<'info, RewardVault>,
    #[account(
        init, payer = payer, seeds = [b"reward_tokens", vault.key().as_ref()], bump,
        token::mint = reward_mint, token::authority = vault, token::token_program = reward_token_program,
    )]
    pub vault_tokens: InterfaceAccount<'info, NftAccount>,
    pub reward_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositReward<'info> {
    pub depositor: Signer<'info>,
    #[account(mut, seeds = [b"reward", vault.nft_mint.as_ref(), vault.reward_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, RewardVault>,
    #[account(mut, seeds = [b"reward_tokens", vault.key().as_ref()], bump = vault.tokens_bump)]
    pub vault_tokens: InterfaceAccount<'info, NftAccount>,
    #[account(address = vault.reward_mint, mint::token_program = token_program)]
    pub reward_mint: InterfaceAccount<'info, NftMint>,
    #[account(mut, token::mint = reward_mint, token::authority = depositor, token::token_program = token_program)]
    pub depositor_tokens: InterfaceAccount<'info, NftAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimReward<'info> {
    pub holder: Signer<'info>,
    #[account(mut, seeds = [b"reward", vault.nft_mint.as_ref(), vault.reward_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, RewardVault>,
    #[account(mut, seeds = [b"reward_tokens", vault.key().as_ref()], bump = vault.tokens_bump)]
    pub vault_tokens: InterfaceAccount<'info, NftAccount>,
    #[account(address = vault.reward_mint, mint::token_program = token_program)]
    pub reward_mint: InterfaceAccount<'info, NftMint>,
    #[account(
        token::mint = vault.nft_mint, token::authority = holder, token::token_program = token_2022_program,
        constraint = holder_nft.amount == 1 @ LockerError::NotNftHolder,
    )]
    pub holder_nft: InterfaceAccount<'info, NftAccount>,
    /// Where the rewards go (the holder picks; usually their own account).
    #[account(mut, token::mint = reward_mint, token::token_program = token_program)]
    pub holder_tokens: InterfaceAccount<'info, NftAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct LockTimed<'info> {
    pub base: LockLp<'info>,
    #[account(
        init, payer = base.owner, space = 8 + LockSchedule::INIT_SPACE,
        seeds = [b"schedule", base.lock.key().as_ref()], bump,
    )]
    pub schedule: Account<'info, LockSchedule>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unlock<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(mut, close = holder, seeds = [b"lock", lock.nft_mint.as_ref()], bump = lock.bump)]
    pub lock: Account<'info, Lock>,
    #[account(mut, close = holder, seeds = [b"schedule", lock.key().as_ref()], bump = schedule.bump, has_one = lock)]
    pub schedule: Account<'info, LockSchedule>,
    #[account(mut, address = lock.nft_mint @ LockerError::NotNftHolder)]
    pub nft_mint: InterfaceAccount<'info, NftMint>,
    #[account(
        mut, token::mint = lock.nft_mint, token::authority = holder, token::token_program = token_2022_program,
        constraint = holder_nft.amount == 1 @ LockerError::NotNftHolder,
    )]
    pub holder_nft: InterfaceAccount<'info, NftAccount>,
    #[account(mut, seeds = [b"vault", lock.key().as_ref()], bump = lock.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = lock.lp_mint, token::authority = holder)]
    pub holder_lp: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(mut, seeds = [b"lock", lock.nft_mint.as_ref()], bump = lock.bump)]
    pub lock: Account<'info, Lock>,
    #[account(
        token::mint = lock.nft_mint, token::authority = holder, token::token_program = token_2022_program,
        constraint = holder_nft.amount == 1 @ LockerError::NotNftHolder,
    )]
    pub holder_nft: InterfaceAccount<'info, NftAccount>,
    #[account(mut, seeds = [b"vault", lock.key().as_ref()], bump = lock.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: must be the locked pool; XDEX checks the rest.
    #[account(mut, address = lock.pool @ LockerError::WrongPoolAccount)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: XDEX vault/LP authority PDA; XDEX verifies it.
    pub xdex_authority: UncheckedAccount<'info>,
    /// CHECK: where token 0 fees go; XDEX checks the mint.
    #[account(mut)]
    pub holder_token_0: UncheckedAccount<'info>,
    /// CHECK: where token 1 fees go; XDEX checks the mint.
    #[account(mut)]
    pub holder_token_1: UncheckedAccount<'info>,
    /// CHECK: checked against the pool.
    #[account(mut)]
    pub token_0_vault: UncheckedAccount<'info>,
    /// CHECK: checked against the pool.
    #[account(mut)]
    pub token_1_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    /// CHECK: checked against the pool.
    pub vault_0_mint: UncheckedAccount<'info>,
    /// CHECK: checked against the pool.
    pub vault_1_mint: UncheckedAccount<'info>,
    /// CHECK: must be the locked LP mint.
    #[account(mut, address = lock.lp_mint @ LockerError::WrongPoolAccount)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: SPL Memo program, required by XDEX withdraw.
    #[account(address = MEMO_PROGRAM_ID)]
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: the XDEX program this build targets.
    #[account(address = XDEX_PROGRAM_ID)]
    pub xdex_program: UncheckedAccount<'info>,
}

#[event]
pub struct Locked {
    pub lock: Pubkey,
    pub nft_mint: Pubkey,
    pub pool: Pubkey,
    pub locker: Pubkey,
    pub lp_amount: u64,
    pub principal: u128,
}

#[event]
pub struct TimedLock {
    pub lock: Pubkey,
    pub unlock_at: i64,
}

#[event]
pub struct Unlocked {
    pub lock: Pubkey,
    pub holder: Pubkey,
    pub lp_amount: u64,
}

#[event]
pub struct RewardDeposited {
    pub vault: Pubkey,
    pub amount: u64,
    pub unlock_at: i64,
}

#[event]
pub struct RewardClaimed {
    pub vault: Pubkey,
    pub holder: Pubkey,
    pub amount: u64,
}

/// One token's pull-based holder rewards. Holds the XNT (as lamports) waiting to be claimed.
#[account]
#[derive(InitSpace)]
pub struct HolderPool {
    pub token_mint: Pubkey,
    /// The token's distributor: the only signer allowed to post roots.
    pub authority: Pubkey,
    pub root: [u8; 32],
    pub epoch: u64,
    /// Everything ever promised to passes (sum of cumulative rewards in the latest root).
    pub total_funded: u64,
    pub total_claimed: u64,
    pub passes: u64,
    pub bump: u8,
}

/// One holder pass. The pass NFT is the claim key; `claimed` follows the pass, not a wallet.
#[account]
#[derive(InitSpace)]
pub struct Pass {
    pub token_mint: Pubkey,
    pub pass_mint: Pubkey,
    pub minter: Pubkey,
    /// Cumulative lamports already claimed by this pass.
    pub claimed: u64,
    pub created_at: i64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitHolderPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: must be a Token-2022 mint whose withdraw-withheld authority is `authority` (checked in the handler).
    pub token_mint: UncheckedAccount<'info>,
    #[account(init, payer = authority, space = 8 + HolderPool::INIT_SPACE, seeds = [b"holders", token_mint.key().as_ref()], bump)]
    pub holder_pool: Account<'info, HolderPool>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRoot<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"holders", holder_pool.token_mint.as_ref()], bump = holder_pool.bump, has_one = authority @ LockerError::NotTokenDistributor)]
    pub holder_pool: Account<'info, HolderPool>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintPass<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"holders", holder_pool.token_mint.as_ref()], bump = holder_pool.bump)]
    pub holder_pool: Account<'info, HolderPool>,
    #[account(mut, mint::token_program = token_2022_program)]
    pub pass_mint: InterfaceAccount<'info, NftMint>,
    #[account(mut, token::mint = pass_mint, token::authority = owner, token::token_program = token_2022_program)]
    pub owner_pass: InterfaceAccount<'info, NftAccount>,
    #[account(init, payer = owner, space = 8 + Pass::INIT_SPACE, seeds = [b"pass", pass_mint.key().as_ref()], bump)]
    pub pass: Account<'info, Pass>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimPass<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(mut, seeds = [b"holders", holder_pool.token_mint.as_ref()], bump = holder_pool.bump)]
    pub holder_pool: Account<'info, HolderPool>,
    #[account(mut, seeds = [b"pass", pass.pass_mint.as_ref()], bump = pass.bump,
        constraint = pass.token_mint == holder_pool.token_mint @ LockerError::WrongPass)]
    pub pass: Account<'info, Pass>,
    #[account(token::mint = pass.pass_mint, token::authority = holder, token::token_program = token_2022_program)]
    pub holder_pass: InterfaceAccount<'info, NftAccount>,
    pub token_2022_program: Program<'info, Token2022>,
}

#[event]
pub struct HolderPoolCreated {
    pub pool: Pubkey,
    pub token_mint: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct RootSet {
    pub pool: Pubkey,
    pub epoch: u64,
    pub root: [u8; 32],
    pub total_rewards: u64,
    pub added: u64,
}

#[event]
pub struct PassMinted {
    pub pass: Pubkey,
    pub pass_mint: Pubkey,
    pub token_mint: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct PassClaimed {
    pub pass: Pubkey,
    pub holder: Pubkey,
    pub amount: u64,
    pub cumulative: u64,
}

#[event]
pub struct FeesCollected {
    pub lock: Pubkey,
    pub holder: Pubkey,
    pub fee_lp: u64,
    pub remaining_lp: u64,
}

#[error_code]
pub enum LockerError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Account does not belong to this XDEX pool")]
    WrongPoolAccount,
    #[msg("Pool has no liquidity")]
    EmptyPool,
    #[msg("NFT mint must be fresh: decimals 0, supply 0, mint authority = locker, no freeze authority, metadata extensions only")]
    BadNftMint,
    #[msg("Signer does not hold the lock NFT")]
    NotNftHolder,
    #[msg("No trading fees to collect yet")]
    NoFeesYet,
    #[msg("Pool withdrawals are paused")]
    PoolWithdrawPaused,
    #[msg("Collect would touch the locked principal")]
    PrincipalViolated,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Unlock time must be in the future")]
    UnlockInPast,
    #[msg("This lock has not reached its unlock time")]
    StillLocked,
    #[msg("Nothing has vested yet")]
    NothingToClaim,
    #[msg("Too many vesting deposits pending; claim first")]
    VestingFull,
    #[msg("Not a Token-2022 tax token")]
    NotTaxToken,
    #[msg("Signer is not this token's distributor (its withdraw-withheld authority)")]
    NotTokenDistributor,
    #[msg("Epoch must increase")]
    StaleEpoch,
    #[msg("Total rewards can't go down")]
    RewardsDecreased,
    #[msg("Signer does not hold this pass")]
    NotPassHolder,
    #[msg("Pass belongs to a different token")]
    WrongPass,
    #[msg("Merkle proof doesn't match the current root")]
    BadProof,
    #[msg("The pool doesn't hold enough to pay this claim")]
    PoolUnderfunded,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a sorted-pair tree the way the distributor does; return (root, proof for `idx`).
    fn tree(leaves: &[[u8; 32]], idx: usize) -> ([u8; 32], Vec<[u8; 32]>) {
        let mut level = leaves.to_vec();
        let (mut i, mut proof) = (idx, vec![]);
        while level.len() > 1 {
            let mut next = vec![];
            for pair in level.chunks(2) {
                next.push(if pair.len() == 1 { pair[0] } else {
                    let (a, b) = if pair[0] <= pair[1] { (pair[0], pair[1]) } else { (pair[1], pair[0]) };
                    hashv(&[&a, &b]).to_bytes()
                });
            }
            if i ^ 1 < level.len() { proof.push(level[i ^ 1]); }
            i /= 2;
            level = next;
        }
        (level[0], proof)
    }

    #[test]
    fn pass_leaf_matches_the_typescript_distributor() {
        // Same vector as test/holder-pass.test.ts: pass mint = [7; 32], cumulative = 123456789.
        let leaf = pass_leaf(&Pubkey::new_from_array([7; 32]), 123_456_789);
        let hex: String = leaf.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, "dd70d581440702b8a509ddc24394cf109f0367548330a6c2601b3fe4092d6b5d");
    }

    #[test]
    fn pass_proofs_verify_and_reject_tampering() {
        let passes: Vec<Pubkey> = (0..7).map(|_| Pubkey::new_unique()).collect();
        let leaves: Vec<[u8; 32]> = passes.iter().enumerate().map(|(i, p)| pass_leaf(p, 1_000 * (i as u64 + 1))).collect();
        for idx in 0..leaves.len() {
            let (root, proof) = tree(&leaves, idx);
            assert!(verify_proof(&proof, &root, leaves[idx]));
            // A different amount for the same pass must fail.
            assert!(!verify_proof(&proof, &root, pass_leaf(&passes[idx], 1_000 * (idx as u64 + 1) + 1)));
            // Another pass can't use this proof.
            assert!(!verify_proof(&proof, &root, pass_leaf(&Pubkey::new_unique(), 1_000 * (idx as u64 + 1))));
        }
        // A single-pass tree: the root is the leaf, empty proof.
        let (root, proof) = tree(&leaves[..1], 0);
        assert!(proof.is_empty() && verify_proof(&proof, &root, leaves[0]));
    }

    fn vault() -> RewardVault {
        RewardVault { nft_mint: Pubkey::default(), reward_mint: Pubkey::default(), claimable: 0, total_deposited: 0,
            total_claimed: 0, tranches: [Tranche::default(); TRANCHES], bump: 0, tokens_bump: 0 }
    }

    #[test]
    fn deposits_vest_after_the_period_and_group_by_bucket() {
        let mut v = vault();
        let t0 = 1_000 * VEST_BUCKET + 5;
        v.add(100, t0).unwrap();
        v.add(50, t0 + 1).unwrap(); // same bucket: same tranche
        assert_eq!(v.tranches.iter().filter(|t| t.amount > 0).count(), 1);
        v.release(t0 + VEST_SECONDS - 1).unwrap();
        assert_eq!(v.claimable, 0, "not vested before the period ends");
        v.release(v.bucket_unlock(t0)).unwrap();
        assert_eq!(v.claimable, 150);
    }

    #[test]
    fn vested_tranches_free_their_slots() {
        let mut v = vault();
        let mut t = 5 * VEST_BUCKET;
        for _ in 0..(TRANCHES * 3) {
            v.add(1, t).unwrap(); // one deposit per bucket for 3x the slot count
            t += VEST_BUCKET;
        }
        v.release(t + VEST_SECONDS + VEST_BUCKET).unwrap();
        assert_eq!(v.claimable, (TRANCHES * 3) as u64);
    }

    #[test]
    fn isqrt_is_exact_floor() {
        for n in [0u128, 1, 2, 3, 4, 15, 16, 17, 1 << 64, u64::MAX as u128 * u64::MAX as u128, u128::MAX] {
            let r = isqrt(n);
            assert!(r * r <= n, "{n}");
            assert!((r + 1).checked_mul(r + 1).map_or(true, |s| s > n), "{n}");
        }
    }

    #[test]
    fn no_fees_until_liquidity_per_lp_grows() {
        let (sqrt_k, supply) = (1_000_000u128, 1_000u128);
        let principal = mul_div_ceil(100, sqrt_k, supply).unwrap();
        assert_eq!(fee_lp(100, principal, sqrt_k, supply).unwrap(), 0);
        // Deposits/withdrawals scale sqrt_k and supply together: still no fees.
        assert_eq!(fee_lp(100, principal, sqrt_k * 3, supply * 3).unwrap(), 0);
    }

    #[test]
    fn fees_are_only_the_growth_and_principal_is_kept() {
        let (sqrt_k, supply) = (1_000_000_000u128, 1_000_000u128);
        let lp = 100_000u64;
        let principal = mul_div_ceil(lp as u128, sqrt_k, supply).unwrap();
        // Trading fees grow sqrt(k) by 1%.
        let grown = sqrt_k * 101 / 100;
        let fee = fee_lp(lp, principal, grown, supply).unwrap();
        assert!(fee > 0 && fee < lp / 100 + 1);
        let remaining_value = mul_div_floor((lp - fee) as u128, grown, supply).unwrap();
        assert!(remaining_value >= principal);
        // Collecting again right away yields nothing.
        assert_eq!(fee_lp(lp - fee, principal, grown, supply).unwrap(), 0);
    }
}
