//! 99 + Tax tax vault (spec: docs/tax-vault-spec.md).
//!
//! A Token-2022 tax token's withdraw-withheld authority is this program's `auth` PDA
//! (`["auth", mint]`): a system-owned, never-allocated address with no private key. The
//! program collects the tax and enforces the token's split:
//!
//! * `collect` harvests withheld tax into the mint, withdraws it to auth's token account,
//!   burns the burn share and books the rest into token buckets (auto-LP tokens kept, and
//!   tokens to sell for the LP's XNT side, the creator reward and the holders).
//! * `sell` sells from the three sell buckets on XDEX with an on-chain price-impact cap
//!   and an on-chain minimum output, and books the XNT pro-rata into lamport buckets held
//!   by `auth`. The caller earns 1% of the holders' part (capped).
//! * `add_liquidity` deposits kept tokens + LP XNT into the pool and burns every LP token.
//! * Payout token (optional, fixed at creation with `init_vault_payout`): holders are paid
//!   in a chosen token instead of XNT. `sell` then books the holders' XNT into `xnt_holders`;
//!   `fund_holders` swaps it into the payout token on the vault's payout pool (impact-capped,
//!   one swap per slot), and `pay_token` / `pay_fallback_token` pay it out. The holder pool
//!   and every list are then counted in the payout token's units. A vault without one pays XNT.
//! * `fund_creator` swaps the creator's XNT into the network's reward token (XNM on
//!   testnet, USDC.X on mainnet) on XDEX with an on-chain price-impact cap and minimum
//!   output, and deposits it into lp_locker's vesting reward vault of the pool's lock NFT.
//! * `upgrade_vault` turns a 480-byte v1 or 552-byte v2 vault into a 640-byte v3 vault in place.
//! * Holders are paid against a Merkle list of cumulative amounts. `publish_list` (the
//!   publisher only) can only raise the list total and never above what the holders'
//!   share has received (`holders_funded`); a list activates after a delay during which
//!   the guardian can `cancel_list`; `pay` (anyone) pays a wallet its cumulative amount
//!   minus what it was already paid, never more than the list total in all. The list
//!   file's IPFS address is stored with each list.
//! * If the operator disappears: the publisher can rotate its own key (`set_publisher`);
//!   the guardian can `appoint_publisher` after APPOINT_AFTER_SECS without a published
//!   list; and after FALLBACK_AFTER_SECS without one anyone can `pay_fallback`, which pays
//!   from the last active list scaled up to everything funded so far.
//!
//! Lamport accounting: `auth` always holds at least
//! `xnt_lp + xnt_creator + (holders_funded - holders_paid)` plus a rent-exempt reserve for
//! a 0-byte account (so payouts can never leave it rent-paying). This is checked at the
//! end of every instruction that can move lamports. Every rounding favours the vault.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_option::COption,
    sysvar::instructions as ix_sysvar,
};
use anchor_lang::system_program;
use anchor_spl::associated_token::{
    self, get_associated_token_address_with_program_id, AssociatedToken, Create as CreateIdempotent,
};
use anchor_spl::token::{self, spl_token::native_mint, Token};
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        transfer_fee::{instruction as fee_ix, TransferFee, TransferFeeConfig},
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    instruction::{AuthorityType, TokenInstruction},
    state::Mint as MintState,
};
use anchor_spl::token_2022::{self as token_2022, Token2022};
use anchor_spl::token_interface::{self, TokenInterface};
use anchor_spl::token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata;
use solana_sha256_hasher::hashv;

declare_id!("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");

pub const LOCKER_PROGRAM_ID: Pubkey = pubkey!("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");

#[cfg(feature = "testnet")]
pub const XDEX_PROGRAM_ID: Pubkey = pubkey!("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
#[cfg(not(feature = "testnet"))]
pub const XDEX_PROGRAM_ID: Pubkey = pubkey!("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");

/// The creator reward token of this network (never chosen per token) and its XNT pool.
#[cfg(feature = "testnet")]
pub const REWARD_MINT: Pubkey = pubkey!("AvNDf423kEmWNP6AZHFV7DkNG4YRgt6qbdyyryjaa4PQ");
#[cfg(feature = "testnet")]
pub const REWARD_POOL: Pubkey = pubkey!("6XESNUXbGNT6x3zaB51Axk7Jh6Ba58LFJukkfPUzzSwA");
#[cfg(not(feature = "testnet"))]
pub const REWARD_MINT: Pubkey = pubkey!("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");
#[cfg(not(feature = "testnet"))]
pub const REWARD_POOL: Pubkey = pubkey!("CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR");

pub const MEMO_PROGRAM_ID: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

pub const BPS: u64 = 10_000;
/// A sale moves the price at most this much (and at most half the token's tax, see `math::impact_bps`).
pub const MAX_IMPACT_BPS: u64 = 300;
/// Minimum output = on-chain expected output x (1 - 0.5%).
pub const OUT_TOLERANCE_BPS: u64 = 50;
/// The caller of `sell` earns 1% of the holders' XNT from that sale ...
pub const CRANK_REWARD_BPS: u64 = 100;
/// ... up to 0.05 XNT.
pub const CRANK_REWARD_CAP: u64 = 50_000_000;
#[cfg(not(feature = "short-windows"))]
pub const LIST_DELAY_SECS: i64 = 600;
/// Local testing only.
#[cfg(feature = "short-windows")]
pub const LIST_DELAY_SECS: i64 = 5;
/// The guardian may appoint a new publisher once the publisher has been silent this long.
#[cfg(not(feature = "short-windows"))]
pub const APPOINT_AFTER_SECS: i64 = 7 * 86_400;
/// Local testing only.
#[cfg(feature = "short-windows")]
pub const APPOINT_AFTER_SECS: i64 = 15;
/// Anyone may `pay_fallback` once no list has been published for this long.
#[cfg(not(feature = "short-windows"))]
pub const FALLBACK_AFTER_SECS: i64 = 30 * 86_400;
/// Local testing only.
#[cfg(feature = "short-windows")]
pub const FALLBACK_AFTER_SECS: i64 = 30;
/// A `sell` whose expected output is under this fails with TooSmall.
pub const MIN_SELL_XNT: u64 = 2_000_000;
/// `add_liquidity` needs at least this much XNT set aside.
pub const MIN_LP_XNT: u64 = 10_000_000;
pub const CREATOR_BPS: u16 = 1000;
/// A reward swap (XNT -> reward token) moves the price at most this much, and at most
/// half the reward pool's trade fee (see `math::reward_impact_bps`).
pub const REWARD_MAX_IMPACT_BPS: u64 = 300;
/// The guardian may cancel at most this many lists in a row (reset when a list goes live).
pub const MAX_CANCELS_IN_ROW: u8 = 2;
/// Vault layout versions: v1 = 480 bytes (no version byte), v2 = 552 bytes, v3 = 640 bytes.
pub const VAULT_VERSION: u8 = 3;
pub const VAULT_V1_LEN: usize = 480;
pub const VAULT_V2_LEN: usize = 552;
pub const VAULT_V3_LEN: usize = 640;
/// sha256("account:Vault")[..8]
pub const VAULT_DISC: [u8; 8] = [0xd3, 0x08, 0xe8, 0x2b, 0x02, 0x98, 0x75, 0x77];
pub const MAX_BURN_BPS: u16 = 5000;
pub const MAX_LP_BPS: u16 = 5000;
pub const MAX_BURN_PLUS_LP_BPS: u16 = 5500;

/// XDEX trade fees are in millionths.
const FEE_DENOM: u128 = 1_000_000;
/// sha256("global:swap_base_input")[..8]
const XDEX_SWAP_BASE_INPUT_DISC: [u8; 8] = [0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde];
/// sha256("global:deposit")[..8]
const XDEX_DEPOSIT_DISC: [u8; 8] = [0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6];
/// sha256("account:PoolState")[..8]
const XDEX_POOL_DISC: [u8; 8] = [0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46];
const XDEX_POOL_LEN: usize = 637;
/// sha256("account:AmmConfig")[..8]
const XDEX_CONFIG_DISC: [u8; 8] = [0xda, 0xf4, 0x21, 0x68, 0xcb, 0xcb, 0x2b, 0x6f];
const XDEX_CONFIG_LEN: usize = 236;
/// Pool status bits: 1 = deposits paused, 4 = swaps paused.
const STATUS_DEPOSIT_PAUSED: u8 = 1;
const STATUS_SWAP_PAUSED: u8 = 1 << 2;
/// sha256("account:Lock")[..8] (lp_locker)
const LOCKER_LOCK_DISC: [u8; 8] = [0x08, 0xff, 0x24, 0xca, 0xd2, 0x16, 0x39, 0x89];
/// sha256("global:deposit_reward")[..8]
const LOCKER_DEPOSIT_REWARD_DISC: [u8; 8] = [0xf5, 0xd8, 0x09, 0xb3, 0xed, 0x31, 0xa5, 0xb5];
/// sha256("global:init_reward_vault")[..8]
const LOCKER_INIT_REWARD_VAULT_DISC: [u8; 8] = [0xb7, 0xe5, 0xb9, 0xf7, 0x6e, 0x72, 0xb3, 0x01];
/// Leaf domain prefix of the rewards list.
pub const LEAF_PREFIX: &[u8] = b"99tax-vault";

#[program]
pub mod tax_vault {
    use super::*;

    /// Create the vault of a Token-2022 tax token whose withdraw-withheld authority is
    /// this vault's `auth`. The signer must be the mint's metadata update authority (its
    /// creator), or the same transaction must hand the withdraw authority to `auth` (a
    /// Token-2022 SetAuthority before this instruction), so nobody can front-run the
    /// creation with their own publisher/guardian.
    pub fn init_vault(ctx: Context<InitVault>, burn_bps: u16, lp_bps: u16, publisher: Pubkey, guardian: Pubkey) -> Result<()> {
        let a = &ctx.accounts;
        check_init(
            burn_bps, lp_bps, &a.mint.to_account_info(), &a.auth.to_account_info(), &a.payer.to_account_info(),
            &a.instructions.to_account_info(), &a.pool.to_account_info(), &a.lock.to_account_info(), &a.creator_nft.key(),
            &a.system_program.to_account_info(),
        )?;
        let (mint, pool, nft) = (a.mint.key(), a.pool.key(), a.creator_nft.key());
        let (bump, auth_bump) = (ctx.bumps.vault, ctx.bumps.auth);
        let v = &mut ctx.accounts.vault;
        setup_vault(v, mint, pool, nft, publisher, guardian, burn_bps, lp_bps, bump, auth_bump, Pubkey::default())?;
        check_solvent(&ctx.accounts.auth.to_account_info(), &ctx.accounts.vault)
    }

    /// `init_vault` for a vault that pays holders in a payout token: the payout token's
    /// XDEX pool against wXNT is fixed here for good (every holders' swap goes through it).
    /// The payout mint must have no freeze authority and no transfer fee / hook / delegate
    /// (only metadata or group extensions), and differ from the tax token.
    pub fn init_vault_payout(ctx: Context<InitVaultPayout>, burn_bps: u16, lp_bps: u16, publisher: Pubkey, guardian: Pubkey) -> Result<()> {
        let a = &ctx.accounts;
        check_init(
            burn_bps, lp_bps, &a.mint.to_account_info(), &a.auth.to_account_info(), &a.payer.to_account_info(),
            &a.instructions.to_account_info(), &a.pool.to_account_info(), &a.lock.to_account_info(), &a.creator_nft.key(),
            &a.system_program.to_account_info(),
        )?;
        require_keys_neq!(a.payout_mint.key(), a.mint.key(), VaultError::BadPayoutMint);
        require_keys_neq!(a.payout_mint.key(), native_mint::ID, VaultError::BadPayoutMint);
        check_payout_mint(&a.payout_mint.to_account_info(), &a.payout_token_program.key())?;
        let pool = PoolView::read(&a.payout_pool.to_account_info())?;
        pool.pair_side(&a.payout_mint.key(), &a.payout_token_program.key()).map_err(|_| error!(VaultError::BadPayoutPool))?;
        require!(pool.status & STATUS_SWAP_PAUSED == 0, VaultError::BadPayoutPool);
        let (mint, pool_key, nft, payout_pool) = (a.mint.key(), a.pool.key(), a.creator_nft.key(), a.payout_pool.key());
        let (bump, auth_bump) = (ctx.bumps.vault, ctx.bumps.auth);
        let v = &mut ctx.accounts.vault;
        setup_vault(v, mint, pool_key, nft, publisher, guardian, burn_bps, lp_bps, bump, auth_bump, payout_pool)?;
        check_solvent(&ctx.accounts.auth.to_account_info(), &ctx.accounts.vault)
    }

    /// Harvest the given token accounts into the mint, withdraw the mint's withheld tax to
    /// auth's token account, burn the burn share and book the rest.
    pub fn collect<'info>(ctx: Context<'_, '_, 'info, 'info, Collect<'info>>) -> Result<()> {
        let a = &ctx.accounts;
        let mint_key = a.vault.mint;
        let auth_seeds: &[&[u8]] = &[b"auth", mint_key.as_ref(), &[a.vault.auth_bump]];
        let auth = a.auth.to_account_info();
        let mint = a.mint.to_account_info();
        let t22 = a.token_2022_program.to_account_info();
        let auth_token = a.auth_token.to_account_info();
        create_ata(
            &a.associated_token_program.to_account_info(),
            &a.caller.to_account_info(),
            &auth_token,
            &auth,
            &mint,
            &a.system_program.to_account_info(),
            &t22,
        )?;
        let before = token_amount(&auth_token, &token_2022::ID)?;

        if !ctx.remaining_accounts.is_empty() {
            let sources: Vec<&Pubkey> = ctx.remaining_accounts.iter().map(|x| x.key).collect();
            let ix = fee_ix::harvest_withheld_tokens_to_mint(&token_2022::ID, &mint_key, &sources)?;
            let mut infos = Vec::with_capacity(ctx.remaining_accounts.len() + 2);
            infos.push(mint.clone());
            infos.extend(ctx.remaining_accounts.iter().cloned());
            infos.push(t22.clone());
            invoke(&ix, &infos)?;
        }
        let ix = fee_ix::withdraw_withheld_tokens_from_mint(&token_2022::ID, &mint_key, auth_token.key, auth.key, &[])?;
        invoke_signed(&ix, &[mint.clone(), auth_token.clone(), auth.clone(), t22.clone()], &[auth_seeds])?;
        let after = token_amount(&auth_token, &token_2022::ID)?;
        let got = after.checked_sub(before).ok_or(VaultError::MathOverflow)?;
        require!(got > 0, VaultError::NothingToCollect);

        let s = math::split(got, a.vault.burn_bps, a.vault.lp_bps, a.vault.creator_bps)?;
        if s.burn > 0 {
            token_2022::burn(
                CpiContext::new_with_signer(
                    t22,
                    token_2022::Burn { mint, from: auth_token.clone(), authority: auth.clone() },
                    &[auth_seeds],
                ),
                s.burn,
            )?;
        }

        let v = &mut ctx.accounts.vault;
        let half = s.lp / 2;
        v.lp_tokens = add(v.lp_tokens, half)?;
        v.sell_lp = add(v.sell_lp, s.lp - half)?;
        v.sell_creator = add(v.sell_creator, s.creator)?;
        v.sell_holders = add(v.sell_holders, s.holders)?;
        v.total_collected = add(v.total_collected, got)?;
        v.total_burned = add(v.total_burned, s.burn)?;
        check_tokens(&auth_token, v)?;
        emit!(Collected { vault: v.key(), got, burned: s.burn });
        check_solvent(&ctx.accounts.auth.to_account_info(), &ctx.accounts.vault)
    }

    /// Sell up to `max_tokens` from the sell buckets for XNT on the vault's pool.
    pub fn sell(ctx: Context<Sell>, max_tokens: u64) -> Result<()> {
        let clock = Clock::get()?;
        let a = &ctx.accounts;
        let v = &a.vault;
        // One sale per slot, so nobody can sandwich several capped sales in one transaction.
        require!(clock.slot > v.last_sell_slot, VaultError::OneSellPerSlot);
        let mint_key = v.mint;
        let auth_seeds: &[&[u8]] = &[b"auth", mint_key.as_ref(), &[v.auth_bump]];

        let pool = PoolView::read(&a.pool.to_account_info())?;
        let side = pool.token_side(&mint_key)?;
        require!(pool.status & STATUS_SWAP_PAUSED == 0, VaultError::BadPool);
        require_keys_eq!(pool.amm_config, a.amm_config.key(), VaultError::WrongAccount);
        require_keys_eq!(pool.observation, a.observation.key(), VaultError::WrongAccount);
        let reserve_in = pool.reserve(side, &a.token_vault.to_account_info())?;
        let reserve_out = pool.reserve(1 - side, &a.wxnt_vault.to_account_info())?;
        let trade_fee_rate = read_trade_fee_rate(&a.amm_config.to_account_info())?;
        let fee = epoch_fee(&a.mint.to_account_info(), clock.epoch)?;
        let tax_bps = u64::from(u16::from(fee.transfer_fee_basis_points));
        let max_fee = u64::from(fee.maximum_fee);

        let buckets = add(add(v.sell_lp, v.sell_creator)?, v.sell_holders)?;
        let cap = math::max_input_for_impact(reserve_in, math::impact_bps(tax_bps), tax_bps, max_fee)?;
        let amount = max_tokens.min(buckets).min(cap);
        require!(amount > 0, VaultError::TooSmall);
        let transfer_fee = fee.calculate_fee(amount).ok_or(VaultError::MathOverflow)?;
        let net_in = amount.checked_sub(transfer_fee).ok_or(VaultError::MathOverflow)?;
        let expected = math::cpmm_out(net_in, reserve_in, reserve_out, trade_fee_rate)?;
        require!(expected >= MIN_SELL_XNT, VaultError::TooSmall);
        let min_out = math::min_out(expected)?;
        let take = math::take(amount, v.sell_lp, v.sell_creator, v.sell_holders)?;

        let auth = a.auth.to_account_info();
        let caller = a.caller.to_account_info();
        let sys = a.system_program.to_account_info();
        let tok = a.token_program.to_account_info();
        let t22 = a.token_2022_program.to_account_info();
        let auth_wxnt = a.auth_wxnt.to_account_info();
        let rent_paid = create_ata(
            &a.associated_token_program.to_account_info(),
            &caller,
            &auth_wxnt,
            &auth,
            &a.native_mint.to_account_info(),
            &sys,
            &tok,
        )?;
        let wxnt_before = token_amount(&auth_wxnt, &token::ID)?;

        // XDEX swap_base_input, same accounts as buildSell in src/xdex.ts.
        let mut data = Vec::with_capacity(24);
        data.extend_from_slice(&XDEX_SWAP_BASE_INPUT_DISC);
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&min_out.to_le_bytes());
        let ix = Instruction {
            program_id: XDEX_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(auth.key(), true),
                AccountMeta::new_readonly(a.xdex_authority.key(), false),
                AccountMeta::new_readonly(a.amm_config.key(), false),
                AccountMeta::new(a.pool.key(), false),
                AccountMeta::new(a.auth_token.key(), false),
                AccountMeta::new(auth_wxnt.key(), false),
                AccountMeta::new(a.token_vault.key(), false),
                AccountMeta::new(a.wxnt_vault.key(), false),
                AccountMeta::new_readonly(t22.key(), false),
                AccountMeta::new_readonly(tok.key(), false),
                AccountMeta::new_readonly(a.mint.key(), false),
                AccountMeta::new_readonly(a.native_mint.key(), false),
                AccountMeta::new(a.observation.key(), false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                auth.clone(),
                a.xdex_authority.to_account_info(),
                a.amm_config.to_account_info(),
                a.pool.to_account_info(),
                a.auth_token.to_account_info(),
                auth_wxnt.clone(),
                a.token_vault.to_account_info(),
                a.wxnt_vault.to_account_info(),
                t22.clone(),
                tok.clone(),
                a.mint.to_account_info(),
                a.native_mint.to_account_info(),
                a.observation.to_account_info(),
                a.xdex_program.to_account_info(),
            ],
            &[auth_seeds],
        )?;
        let out = token_amount(&auth_wxnt, &token::ID)?.checked_sub(wxnt_before).ok_or(VaultError::MathOverflow)?;
        require!(out >= min_out, VaultError::TooSmall);

        // Unwrap: every lamport of the wXNT account comes back to auth; the caller gets back
        // the rent they paid for it.
        token::close_account(CpiContext::new_with_signer(
            tok,
            token::CloseAccount { account: auth_wxnt, destination: auth.clone(), authority: auth.clone() },
            &[auth_seeds],
        ))?;
        pay_from_auth(&sys, &auth, &caller, rent_paid, auth_seeds)?;

        let p = math::proceeds(out, amount, &take)?;
        pay_from_auth(&sys, &auth, &caller, p.reward, auth_seeds)?;

        let v = &mut ctx.accounts.vault;
        v.sell_lp -= take.lp;
        v.sell_creator -= take.creator;
        v.sell_holders -= take.holders;
        v.xnt_lp = add(v.xnt_lp, p.lp)?;
        v.xnt_creator = add(v.xnt_creator, p.creator)?;
        if v.payout_pool == Pubkey::default() {
            v.holders_funded = add(v.holders_funded, p.holders - p.reward)?;
        } else {
            v.xnt_holders = add(v.xnt_holders, p.holders - p.reward)?;
        }
        v.total_crank_rewards = add(v.total_crank_rewards, p.reward)?;
        v.last_sell_slot = clock.slot;
        check_tokens(&ctx.accounts.auth_token.to_account_info(), v)?;
        emit!(Sold {
            vault: v.key(),
            tokens_in: amount,
            xnt_out: out,
            to_lp: p.lp,
            to_creator: p.creator,
            to_holders: p.holders - p.reward,
            crank_reward: p.reward,
        });
        check_solvent(&ctx.accounts.auth.to_account_info(), &ctx.accounts.vault)
    }

    /// Deposit kept auto-LP tokens + LP XNT into the pool at its current ratio and burn
    /// every LP token received. Leftovers stay for next time.
    pub fn add_liquidity(ctx: Context<AddLiquidity>) -> Result<()> {
        let clock = Clock::get()?;
        let a = &ctx.accounts;
        let v = &a.vault;
        require!(v.xnt_lp >= MIN_LP_XNT, VaultError::TooSmall);
        let mint_key = v.mint;
        let auth_seeds: &[&[u8]] = &[b"auth", mint_key.as_ref(), &[v.auth_bump]];

        let pool = PoolView::read(&a.pool.to_account_info())?;
        let side = pool.token_side(&mint_key)?;
        require!(pool.status & STATUS_DEPOSIT_PAUSED == 0, VaultError::BadPool);
        require_keys_eq!(pool.lp_mint, a.lp_mint.key(), VaultError::WrongAccount);
        require_keys_eq!(*a.lp_mint.owner, token::ID, VaultError::WrongAccount);
        let reserve_token = pool.reserve(side, &a.token_vault.to_account_info())?;
        let reserve_xnt = pool.reserve(1 - side, &a.wxnt_vault.to_account_info())?;
        let fee = epoch_fee(&a.mint.to_account_info(), clock.epoch)?;

        let auth_token = a.auth_token.to_account_info();
        let token_before = token_amount(&auth_token, &token_2022::ID)?;
        let tokens = v.lp_tokens.min(token_before);
        let xnt = v.xnt_lp;
        let q = math::deposit_for(tokens, xnt, reserve_token, reserve_xnt, pool.lp_supply, |n| fee.calculate_inverse_fee(n))?
            .ok_or(VaultError::TooSmall)?;

        let auth = a.auth.to_account_info();
        let caller = a.caller.to_account_info();
        let sys = a.system_program.to_account_info();
        let tok = a.token_program.to_account_info();
        let t22 = a.token_2022_program.to_account_info();
        let ata_prog = a.associated_token_program.to_account_info();
        let auth_wxnt = a.auth_wxnt.to_account_info();
        let auth_lp = a.auth_lp.to_account_info();
        let rent_wxnt = create_ata(&ata_prog, &caller, &auth_wxnt, &auth, &a.native_mint.to_account_info(), &sys, &tok)?;
        let rent_lp = create_ata(&ata_prog, &caller, &auth_lp, &auth, &a.lp_mint.to_account_info(), &sys, &tok)?;
        pay_from_auth(&sys, &auth, &auth_wxnt, xnt, auth_seeds)?;
        token::sync_native(CpiContext::new(tok.clone(), token::SyncNative { account: auth_wxnt.clone() }))?;
        let wxnt_before = token_amount(&auth_wxnt, &token::ID)?;
        let lp_before = token_amount(&auth_lp, &token::ID)?;

        // XDEX deposit, same accounts as buildDepositAndBurn in src/xdex.ts.
        let (acc0, acc1, max0, max1) =
            if side == 0 { (&auth_token, &auth_wxnt, tokens, xnt) } else { (&auth_wxnt, &auth_token, xnt, tokens) };
        let (vault0, vault1) = if side == 0 {
            (a.token_vault.to_account_info(), a.wxnt_vault.to_account_info())
        } else {
            (a.wxnt_vault.to_account_info(), a.token_vault.to_account_info())
        };
        let (mint0, mint1) = if side == 0 {
            (a.mint.to_account_info(), a.native_mint.to_account_info())
        } else {
            (a.native_mint.to_account_info(), a.mint.to_account_info())
        };
        let mut data = Vec::with_capacity(32);
        data.extend_from_slice(&XDEX_DEPOSIT_DISC);
        data.extend_from_slice(&q.lp.to_le_bytes());
        data.extend_from_slice(&max0.to_le_bytes());
        data.extend_from_slice(&max1.to_le_bytes());
        let ix = Instruction {
            program_id: XDEX_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(auth.key(), true),
                AccountMeta::new_readonly(a.xdex_authority.key(), false),
                AccountMeta::new(a.pool.key(), false),
                AccountMeta::new(auth_lp.key(), false),
                AccountMeta::new(acc0.key(), false),
                AccountMeta::new(acc1.key(), false),
                AccountMeta::new(vault0.key(), false),
                AccountMeta::new(vault1.key(), false),
                AccountMeta::new_readonly(tok.key(), false),
                AccountMeta::new_readonly(t22.key(), false),
                AccountMeta::new_readonly(mint0.key(), false),
                AccountMeta::new_readonly(mint1.key(), false),
                AccountMeta::new(a.lp_mint.key(), false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                auth.clone(),
                a.xdex_authority.to_account_info(),
                a.pool.to_account_info(),
                auth_lp.clone(),
                acc0.clone(),
                acc1.clone(),
                vault0,
                vault1,
                tok.clone(),
                t22.clone(),
                mint0,
                mint1,
                a.lp_mint.to_account_info(),
                a.xdex_program.to_account_info(),
            ],
            &[auth_seeds],
        )?;
        let tokens_used = token_before.checked_sub(token_amount(&auth_token, &token_2022::ID)?).ok_or(VaultError::MathOverflow)?;
        let xnt_used = wxnt_before.checked_sub(token_amount(&auth_wxnt, &token::ID)?).ok_or(VaultError::MathOverflow)?;
        require!(tokens_used <= tokens && xnt_used <= xnt, VaultError::MathOverflow);
        let lp_got = token_amount(&auth_lp, &token::ID)?;
        require!(lp_got > lp_before, VaultError::TooSmall);

        // Burn every LP token auth holds, then give back both temporary accounts.
        token::burn(
            CpiContext::new_with_signer(
                tok.clone(),
                token::Burn { mint: a.lp_mint.to_account_info(), from: auth_lp.clone(), authority: auth.clone() },
                &[auth_seeds],
            ),
            lp_got,
        )?;
        token::close_account(CpiContext::new_with_signer(
            tok.clone(),
            token::CloseAccount { account: auth_lp, destination: auth.clone(), authority: auth.clone() },
            &[auth_seeds],
        ))?;
        token::close_account(CpiContext::new_with_signer(
            tok,
            token::CloseAccount { account: auth_wxnt, destination: auth.clone(), authority: auth.clone() },
            &[auth_seeds],
        ))?;
        pay_from_auth(&sys, &auth, &caller, add(rent_wxnt, rent_lp)?, auth_seeds)?;

        let v = &mut ctx.accounts.vault;
        v.lp_tokens -= tokens_used;
        v.xnt_lp -= xnt_used;
        v.total_lp_tokens = add(v.total_lp_tokens, tokens_used)?;
        v.total_lp_xnt = add(v.total_lp_xnt, xnt_used)?;
        check_tokens(&ctx.accounts.auth_token.to_account_info(), v)?;
        emit!(LiquidityAdded { vault: v.key(), tokens: tokens_used, xnt: xnt_used, lp_burned: lp_got });
        check_solvent(&ctx.accounts.auth.to_account_info(), &ctx.accounts.vault)
    }

    /// Swap (up to) the creator's XNT into the network's reward token on the reward pool
    /// and deposit it into lp_locker's reward vault of the lock NFT; it vests there and the
    /// NFT holder claims it.
    pub fn fund_creator(ctx: Context<FundCreator>) -> Result<()> {
        let clock = Clock::get()?;
        let a = &ctx.accounts;
        let v = &a.vault;
        // One reward swap per slot, so several capped swaps can't be sandwiched together.
        require!(clock.slot > v.last_reward_slot, VaultError::OneSellPerSlot);
        require!(v.xnt_creator > 0, VaultError::TooSmall);
        let mint_key = v.mint;
        let auth_seeds: &[&[u8]] = &[b"auth", mint_key.as_ref(), &[v.auth_bump]];
        let nft = a.creator_nft.key();
        let reward_mint = a.reward_mint.key();
        let reward_program = a.reward_token_program.key();
        let locker_pda = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &LOCKER_PROGRAM_ID).0;
        require_keys_eq!(a.lock.key(), locker_pda(&[b"lock", nft.as_ref()]), VaultError::WrongAccount);
        let reward_vault = locker_pda(&[b"reward", nft.as_ref(), reward_mint.as_ref()]);
        require_keys_eq!(a.reward_vault.key(), reward_vault, VaultError::WrongAccount);
        require_keys_eq!(
            a.reward_tokens.key(),
            locker_pda(&[b"reward_tokens", reward_vault.as_ref()]),
            VaultError::WrongAccount
        );
        check_reward_mint(&a.reward_mint.to_account_info(), &reward_program)?;

        // A payout-token vault passes its payout pool (the first remaining account). When the
        // payout token is the reward token, auth's reward account is also the holders' payout
        // account: what the holders are owed stays in it and only the rest goes to the creator.
        let shared = if v.payout_pool != Pubkey::default() {
            let payout_pool = ctx.remaining_accounts.first().ok_or(error!(VaultError::WrongAccount))?;
            require_keys_eq!(payout_pool.key(), v.payout_pool, VaultError::WrongAccount);
            PoolView::read(payout_pool)?.pair_side(&reward_mint, &reward_program).is_ok()
        } else {
            false
        };
        let keep = if shared { v.holders_funded.checked_sub(v.holders_paid).ok_or(VaultError::Insolvent)? } else { 0 };

        // The reward pool: reward token / wXNT, swaps open, its own config/observation/vaults.
        let pool = PoolView::read(&a.reward_pool.to_account_info())?;
        let side = pool.pair_side(&reward_mint, &reward_program)?;
        require!(pool.status & STATUS_SWAP_PAUSED == 0, VaultError::BadPool);
        require_keys_eq!(pool.amm_config, a.reward_amm_config.key(), VaultError::WrongAccount);
        require_keys_eq!(pool.observation, a.reward_observation.key(), VaultError::WrongAccount);
        let reserve_xnt = pool.reserve(1 - side, &a.reward_pool_wxnt_vault.to_account_info())?;
        let reserve_reward = pool.reserve(side, &a.reward_pool_reward_vault.to_account_info())?;
        let trade_fee_rate = read_trade_fee_rate(&a.reward_amm_config.to_account_info())?;
        let xnt_in = math::reward_swap_in(v.xnt_creator, reserve_xnt, trade_fee_rate)?;
        require!(xnt_in > 0, VaultError::TooSmall);
        let expected = math::cpmm_out(xnt_in, reserve_xnt, reserve_reward, trade_fee_rate)?;
        let min_out = math::min_out(expected)?;
        require!(min_out > 0, VaultError::TooSmall);

        let auth = a.auth.to_account_info();
        let caller = a.caller.to_account_info();
        let sys = a.system_program.to_account_info();
        let tok = a.token_program.to_account_info();
        let rtok = a.reward_token_program.to_account_info();
        let ata_prog = a.associated_token_program.to_account_info();
        let locker = a.locker_program.to_account_info();

        if a.reward_vault.data_is_empty() {
            let ix = Instruction {
                program_id: LOCKER_PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new(caller.key(), true),
                    AccountMeta::new_readonly(nft, false),
                    AccountMeta::new_readonly(a.lock.key(), false),
                    AccountMeta::new_readonly(reward_mint, false),
                    AccountMeta::new(a.reward_vault.key(), false),
                    AccountMeta::new(a.reward_tokens.key(), false),
                    AccountMeta::new_readonly(reward_program, false),
                    AccountMeta::new_readonly(a.token_2022_program.key(), false),
                    AccountMeta::new_readonly(sys.key(), false),
                ],
                data: LOCKER_INIT_REWARD_VAULT_DISC.to_vec(),
            };
            invoke(
                &ix,
                &[
                    caller.clone(),
                    a.creator_nft.to_account_info(),
                    a.lock.to_account_info(),
                    a.reward_mint.to_account_info(),
                    a.reward_vault.to_account_info(),
                    a.reward_tokens.to_account_info(),
                    rtok.clone(),
                    a.token_2022_program.to_account_info(),
                    sys.clone(),
                    locker.clone(),
                ],
            )?;
        }

        // Wrap xnt_in, and open auth's reward-token account (both paid by the caller and
        // refunded below).
        let auth_wxnt = a.auth_wxnt.to_account_info();
        let auth_reward = a.auth_reward.to_account_info();
        let rent_wxnt = create_ata(&ata_prog, &caller, &auth_wxnt, &auth, &a.native_mint.to_account_info(), &sys, &tok)?;
        let rent_reward = create_ata(&ata_prog, &caller, &auth_reward, &auth, &a.reward_mint.to_account_info(), &sys, &rtok)?;
        pay_from_auth(&sys, &auth, &auth_wxnt, xnt_in, auth_seeds)?;
        token::sync_native(CpiContext::new(tok.clone(), token::SyncNative { account: auth_wxnt.clone() }))?;
        let wxnt_before = token_amount(&auth_wxnt, &token::ID)?;
        let reward_before = token_amount(&auth_reward, &reward_program)?;

        // XDEX swap_base_input XNT -> reward token (same account order as in `sell`).
        let mut data = Vec::with_capacity(24);
        data.extend_from_slice(&XDEX_SWAP_BASE_INPUT_DISC);
        data.extend_from_slice(&xnt_in.to_le_bytes());
        data.extend_from_slice(&min_out.to_le_bytes());
        let ix = Instruction {
            program_id: XDEX_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(auth.key(), true),
                AccountMeta::new_readonly(a.xdex_authority.key(), false),
                AccountMeta::new_readonly(a.reward_amm_config.key(), false),
                AccountMeta::new(a.reward_pool.key(), false),
                AccountMeta::new(auth_wxnt.key(), false),
                AccountMeta::new(auth_reward.key(), false),
                AccountMeta::new(a.reward_pool_wxnt_vault.key(), false),
                AccountMeta::new(a.reward_pool_reward_vault.key(), false),
                AccountMeta::new_readonly(tok.key(), false),
                AccountMeta::new_readonly(reward_program, false),
                AccountMeta::new_readonly(a.native_mint.key(), false),
                AccountMeta::new_readonly(reward_mint, false),
                AccountMeta::new(a.reward_observation.key(), false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                auth.clone(),
                a.xdex_authority.to_account_info(),
                a.reward_amm_config.to_account_info(),
                a.reward_pool.to_account_info(),
                auth_wxnt.clone(),
                auth_reward.clone(),
                a.reward_pool_wxnt_vault.to_account_info(),
                a.reward_pool_reward_vault.to_account_info(),
                tok.clone(),
                rtok.clone(),
                a.native_mint.to_account_info(),
                a.reward_mint.to_account_info(),
                a.reward_observation.to_account_info(),
                a.xdex_program.to_account_info(),
            ],
            &[auth_seeds],
        )?;
        let spent = wxnt_before.checked_sub(token_amount(&auth_wxnt, &token::ID)?).ok_or(VaultError::MathOverflow)?;
        require!(spent == xnt_in, VaultError::MathOverflow);
        let held = token_amount(&auth_reward, &reward_program)?;
        let out = held.checked_sub(reward_before).ok_or(VaultError::MathOverflow)?;
        require!(out >= min_out, VaultError::TooSmall);
        let deposit = math::creator_deposit(reward_before, held, keep)?;

        // Unwrap: every lamport of the wXNT account (rent + anything left) comes back to auth.
        token::close_account(CpiContext::new_with_signer(
            tok,
            token::CloseAccount { account: auth_wxnt.clone(), destination: auth.clone(), authority: auth.clone() },
            &[auth_seeds],
        ))?;

        // Deposit everything auth's reward account holds (the swap output, plus anything
        // sent to that account before, so it can always be closed), except the holders'
        // tokens when it is also their payout account.
        let mut data = Vec::with_capacity(16);
        data.extend_from_slice(&LOCKER_DEPOSIT_REWARD_DISC);
        data.extend_from_slice(&deposit.to_le_bytes());
        let ix = Instruction {
            program_id: LOCKER_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(auth.key(), true),
                AccountMeta::new(a.reward_vault.key(), false),
                AccountMeta::new(a.reward_tokens.key(), false),
                AccountMeta::new_readonly(reward_mint, false),
                AccountMeta::new(auth_reward.key(), false),
                AccountMeta::new_readonly(reward_program, false),
            ],
            data,
        };
        let vault_tokens_before = token_amount(&a.reward_tokens.to_account_info(), &reward_program)?;
        invoke_signed(
            &ix,
            &[
                auth.clone(),
                a.reward_vault.to_account_info(),
                a.reward_tokens.to_account_info(),
                a.reward_mint.to_account_info(),
                auth_reward.clone(),
                rtok.clone(),
                locker,
            ],
            &[auth_seeds],
        )?;
        require!(token_amount(&auth_reward, &reward_program)? == keep, VaultError::WrongAccount);
        let received = token_amount(&a.reward_tokens.to_account_info(), &reward_program)?
            .checked_sub(vault_tokens_before)
            .ok_or(VaultError::MathOverflow)?;
        require!(received == deposit, VaultError::BadRewardMint);

        if !shared {
            token_interface::close_account(CpiContext::new_with_signer(
                rtok,
                token_interface::CloseAccount { account: auth_reward.clone(), destination: auth.clone(), authority: auth.clone() },
                &[auth_seeds],
            ))?;
            require!(auth_reward.lamports() == 0, VaultError::WrongAccount);
        }
        require!(auth_wxnt.lamports() == 0, VaultError::WrongAccount);
        pay_from_auth(&sys, &auth, &caller, add(rent_wxnt, rent_reward)?, auth_seeds)?;

        let v = &mut ctx.accounts.vault;
        // The shared account stays open as the holders' payout account; if it was opened here,
        // its rent comes out of the holders' XNT, as in `fund_holders`.
        if shared {
            v.xnt_holders = v.xnt_holders.checked_sub(rent_reward).ok_or(VaultError::TooSmall)?;
        }
        v.xnt_creator -= xnt_in;
        v.total_creator_xnt = add(v.total_creator_xnt, xnt_in)?;
        v.total_reward_out = add(v.total_reward_out, deposit)?;
        v.last_reward_slot = clock.slot;
        emit!(CreatorFunded { vault: v.key(), xnt_in, reward_out: deposit, reward_mint });
        check_solvent(&ctx.accounts.auth.to_account_info(), &ctx.accounts.vault)?;
        if shared {
            check_payout_tokens(&auth_reward, &reward_program, &ctx.accounts.vault)?;
        }
        Ok(())
    }

    /// Payout-token vaults: swap (up to) the holders' XNT into the payout token on the
    /// vault's payout pool (impact-capped like the reward swap, sharing its one-swap-per-slot
    /// rule) and keep it in auth's payout-token account, adding it to the holder pool. The
    /// first call opens that account; its rent comes out of the holders' XNT.
    pub fn fund_holders(ctx: Context<FundHolders>) -> Result<()> {
        let clock = Clock::get()?;
        let a = &ctx.accounts;
        let v = &a.vault;
        require!(v.payout_pool != Pubkey::default(), VaultError::PaysInXnt);
        require!(clock.slot > v.last_reward_slot, VaultError::OneSellPerSlot);
        require!(v.xnt_holders > 0, VaultError::TooSmall);
        let mint_key = v.mint;
        let auth_seeds: &[&[u8]] = &[b"auth", mint_key.as_ref(), &[v.auth_bump]];
        let payout_mint = a.payout_mint.key();
        let payout_program = a.payout_token_program.key();
        check_payout_mint(&a.payout_mint.to_account_info(), &payout_program)?;
        let pool = PoolView::read(&a.payout_pool.to_account_info())?;
        let side = pool.pair_side(&payout_mint, &payout_program).map_err(|_| error!(VaultError::BadPayoutPool))?;
        require!(pool.status & STATUS_SWAP_PAUSED == 0, VaultError::BadPool);
        require_keys_eq!(pool.amm_config, a.payout_amm_config.key(), VaultError::WrongAccount);
        require_keys_eq!(pool.observation, a.payout_observation.key(), VaultError::WrongAccount);
        let reserve_xnt = pool.reserve(1 - side, &a.payout_pool_wxnt_vault.to_account_info())?;
        let reserve_payout = pool.reserve(side, &a.payout_pool_payout_vault.to_account_info())?;
        let trade_fee_rate = read_trade_fee_rate(&a.payout_amm_config.to_account_info())?;

        let auth = a.auth.to_account_info();
        let caller = a.caller.to_account_info();
        let sys = a.system_program.to_account_info();
        let tok = a.token_program.to_account_info();
        let ptok = a.payout_token_program.to_account_info();
        let ata_prog = a.associated_token_program.to_account_info();
        let auth_wxnt = a.auth_wxnt.to_account_info();
        let auth_payout = a.auth_payout.to_account_info();

        // auth's payout-token account stays open for good; its rent comes from the holders' XNT.
        let rent_payout = create_ata(&ata_prog, &caller, &auth_payout, &auth, &a.payout_mint.to_account_info(), &sys, &ptok)?;
        let available = v.xnt_holders.checked_sub(rent_payout).ok_or(VaultError::TooSmall)?;
        pay_from_auth(&sys, &auth, &caller, rent_payout, auth_seeds)?;
        let xnt_in = math::reward_swap_in(available, reserve_xnt, trade_fee_rate)?;
        require!(xnt_in > 0, VaultError::TooSmall);
        let expected = math::cpmm_out(xnt_in, reserve_xnt, reserve_payout, trade_fee_rate)?;
        let min_out = math::min_out(expected)?;
        require!(min_out > 0, VaultError::TooSmall);

        let rent_wxnt = create_ata(&ata_prog, &caller, &auth_wxnt, &auth, &a.native_mint.to_account_info(), &sys, &tok)?;
        pay_from_auth(&sys, &auth, &auth_wxnt, xnt_in, auth_seeds)?;
        token::sync_native(CpiContext::new(tok.clone(), token::SyncNative { account: auth_wxnt.clone() }))?;
        let wxnt_before = token_amount(&auth_wxnt, &token::ID)?;
        let payout_before = token_amount(&auth_payout, &payout_program)?;

        // XDEX swap_base_input XNT -> payout token (same account order as `fund_creator`).
        let mut data = Vec::with_capacity(24);
        data.extend_from_slice(&XDEX_SWAP_BASE_INPUT_DISC);
        data.extend_from_slice(&xnt_in.to_le_bytes());
        data.extend_from_slice(&min_out.to_le_bytes());
        let ix = Instruction {
            program_id: XDEX_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(auth.key(), true),
                AccountMeta::new_readonly(a.xdex_authority.key(), false),
                AccountMeta::new_readonly(a.payout_amm_config.key(), false),
                AccountMeta::new(a.payout_pool.key(), false),
                AccountMeta::new(auth_wxnt.key(), false),
                AccountMeta::new(auth_payout.key(), false),
                AccountMeta::new(a.payout_pool_wxnt_vault.key(), false),
                AccountMeta::new(a.payout_pool_payout_vault.key(), false),
                AccountMeta::new_readonly(tok.key(), false),
                AccountMeta::new_readonly(payout_program, false),
                AccountMeta::new_readonly(a.native_mint.key(), false),
                AccountMeta::new_readonly(payout_mint, false),
                AccountMeta::new(a.payout_observation.key(), false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                auth.clone(),
                a.xdex_authority.to_account_info(),
                a.payout_amm_config.to_account_info(),
                a.payout_pool.to_account_info(),
                auth_wxnt.clone(),
                auth_payout.clone(),
                a.payout_pool_wxnt_vault.to_account_info(),
                a.payout_pool_payout_vault.to_account_info(),
                tok.clone(),
                ptok.clone(),
                a.native_mint.to_account_info(),
                a.payout_mint.to_account_info(),
                a.payout_observation.to_account_info(),
                a.xdex_program.to_account_info(),
            ],
            &[auth_seeds],
        )?;
        let spent = wxnt_before.checked_sub(token_amount(&auth_wxnt, &token::ID)?).ok_or(VaultError::MathOverflow)?;
        require!(spent == xnt_in, VaultError::MathOverflow);
        let out = token_amount(&auth_payout, &payout_program)?.checked_sub(payout_before).ok_or(VaultError::MathOverflow)?;
        require!(out >= min_out, VaultError::TooSmall);

        token::close_account(CpiContext::new_with_signer(
            tok,
            token::CloseAccount { account: auth_wxnt.clone(), destination: auth.clone(), authority: auth.clone() },
            &[auth_seeds],
        ))?;
        require!(auth_wxnt.lamports() == 0, VaultError::WrongAccount);
        pay_from_auth(&sys, &auth, &caller, rent_wxnt, auth_seeds)?;

        let v = &mut ctx.accounts.vault;
        v.xnt_holders -= add(xnt_in, rent_payout)?;
        v.holders_funded = add(v.holders_funded, out)?;
        v.last_reward_slot = clock.slot;
        check_payout_tokens(&ctx.accounts.auth_payout.to_account_info(), &payout_program, v)?;
        emit!(HoldersFunded { vault: v.key(), xnt_in, payout_out: out, payout_mint });
        check_solvent(&ctx.accounts.auth.to_account_info(), &ctx.accounts.vault)
    }

    /// Upgrade a 480-byte v1 or 552-byte v2 vault to the 640-byte v3 layout in place
    /// (anyone; the payer pays the extra rent). A v1 vault's creator reward switches to the
    /// network's reward token; the appoint / fallback clocks start now.
    pub fn upgrade_vault(ctx: Context<UpgradeVault>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let vault = ctx.accounts.vault.to_account_info();
        let old_len = {
            let d = vault.try_borrow_data()?;
            require!(d.len() >= 8 && d[..8] == VAULT_DISC, VaultError::WrongAccount);
            require!(
                d.len() == VAULT_V1_LEN || (d.len() == VAULT_V2_LEN && d[VERSION_OFFSET] == 2),
                VaultError::WrongVersion
            );
            // The account is this program's ["vault", mint] PDA with its stored bump.
            let mint = Pubkey::new_from_array(d[8..40].try_into().unwrap());
            let expected = Pubkey::create_program_address(&[b"vault", mint.as_ref(), &[d[V1_BUMP_OFFSET]]], &crate::ID)
                .map_err(|_| error!(VaultError::WrongAccount))?;
            require_keys_eq!(expected, vault.key(), VaultError::WrongAccount);
            d.len()
        };
        let need = Rent::get()?.minimum_balance(VAULT_V3_LEN).saturating_sub(vault.lamports());
        if need > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer { from: ctx.accounts.payer.to_account_info(), to: vault.clone() },
                ),
                need,
            )?;
        }
        vault.resize(VAULT_V3_LEN)?;
        let mut d = vault.try_borrow_mut_data()?;
        upgrade_layout(&mut d, old_len, now)
    }

    /// Publish a new rewards list (pending for LIST_DELAY_SECS); `cid` is the list file's
    /// IPFS address ([codec, sha256 digest], stored, never interpreted).
    pub fn publish_list(ctx: Context<PublishList>, root: [u8; 32], epoch: u64, total: u64, cid: [u8; 33]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let v = &mut ctx.accounts.vault;
        require_keys_eq!(ctx.accounts.publisher.key(), v.publisher, VaultError::NotPublisher);
        activate_if_due(v, now);
        math::check_publish(
            v.list_epoch,
            v.pending_epoch,
            v.list_total,
            v.pending_total,
            v.holders_funded,
            v.holders_paid,
            epoch,
            total,
        )?;
        let active_at = now.checked_add(LIST_DELAY_SECS).ok_or(VaultError::MathOverflow)?;
        v.pending_epoch = epoch;
        v.pending_root = root;
        v.pending_total = total;
        v.pending_active_at = active_at;
        v.pending_cid = cid;
        // A publish ends a fallback and restarts the appoint / fallback clocks.
        v.last_publish_at = now;
        emit!(ListPublished { vault: v.key(), epoch, root, total, active_at });
        Ok(())
    }

    /// The guardian clears a pending list (any time until it has been activated), at most
    /// MAX_CANCELS_IN_ROW times until a list goes live.
    pub fn cancel_list(ctx: Context<CancelList>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        require_keys_eq!(ctx.accounts.guardian.key(), v.guardian, VaultError::NotGuardian);
        require!(v.pending_epoch != 0, VaultError::NoPendingList);
        v.cancels_in_row = math::next_cancel(v.cancels_in_row)?;
        let epoch = v.pending_epoch;
        v.pending_epoch = 0;
        v.pending_root = [0; 32];
        v.pending_total = 0;
        v.pending_active_at = 0;
        v.pending_cid = [0; 33];
        emit!(ListCancelled { vault: v.key(), epoch });
        Ok(())
    }

    /// The publisher hands its role to a new key (immediate).
    pub fn set_publisher(ctx: Context<SetPublisher>, new_publisher: Pubkey) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        require_keys_eq!(ctx.accounts.publisher.key(), v.publisher, VaultError::NotPublisher);
        let old = v.publisher;
        v.publisher = new_publisher;
        emit!(PublisherChanged { vault: v.key(), old, new: new_publisher, by_guardian: false });
        Ok(())
    }

    /// The guardian appoints a new publisher, only after the publisher has been silent for
    /// APPOINT_AFTER_SECS (so a stolen guardian key can't take over a live operator). It
    /// doesn't restart the clock; the new publisher does by publishing.
    pub fn appoint_publisher(ctx: Context<AppointPublisher>, new_publisher: Pubkey) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let v = &mut ctx.accounts.vault;
        require_keys_eq!(ctx.accounts.guardian.key(), v.guardian, VaultError::NotGuardian);
        math::check_appoint(v.last_publish_at, now)?;
        let old = v.publisher;
        v.publisher = new_publisher;
        emit!(PublisherChanged { vault: v.key(), old, new: new_publisher, by_guardian: true });
        Ok(())
    }

    /// Pay `wallet` its `cumulative` amount from the active list minus what it was paid (XNT vaults).
    pub fn pay(ctx: Context<Pay>, cumulative: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        let accs = ctx.accounts;
        require!(accs.vault.payout_pool == Pubkey::default(), VaultError::PaysInToken);
        let amount = book_pay(&mut accs.vault, &mut accs.record, ctx.bumps.record, &accs.wallet.key(), &accs.auth.key(), cumulative, &proof, false)?;
        let mint_key = accs.vault.mint;
        let auth_seeds: &[&[u8]] = &[b"auth", mint_key.as_ref(), &[accs.vault.auth_bump]];
        pay_from_auth(&accs.system_program.to_account_info(), &accs.auth.to_account_info(), &accs.wallet.to_account_info(), amount, auth_seeds)?;
        check_solvent(&accs.auth.to_account_info(), &accs.vault)
    }

    /// Fallback (no list published for FALLBACK_AFTER_SECS): pay `wallet` its share of the
    /// last active list scaled up to everything funded so far,
    /// `floor(cumulative * holders_funded / list_total)`, minus what it was paid. Same
    /// accounts as `pay` (XNT vaults).
    pub fn pay_fallback(ctx: Context<Pay>, cumulative: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        let accs = ctx.accounts;
        require!(accs.vault.payout_pool == Pubkey::default(), VaultError::PaysInToken);
        let amount = book_pay(&mut accs.vault, &mut accs.record, ctx.bumps.record, &accs.wallet.key(), &accs.auth.key(), cumulative, &proof, true)?;
        let mint_key = accs.vault.mint;
        let auth_seeds: &[&[u8]] = &[b"auth", mint_key.as_ref(), &[accs.vault.auth_bump]];
        pay_from_auth(&accs.system_program.to_account_info(), &accs.auth.to_account_info(), &accs.wallet.to_account_info(), amount, auth_seeds)?;
        check_solvent(&accs.auth.to_account_info(), &accs.vault)
    }

    /// `pay` for a payout-token vault: the amount (in payout-token units) goes from auth's
    /// payout account to the wallet's, opened here if needed (paid by `payer`).
    pub fn pay_token(ctx: Context<PayToken>, cumulative: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        pay_token_inner(ctx, cumulative, proof, false)
    }

    /// `pay_fallback` for a payout-token vault (same accounts as `pay_token`).
    pub fn pay_fallback_token(ctx: Context<PayToken>, cumulative: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        pay_token_inner(ctx, cumulative, proof, true)
    }
}

/// Check a payout proof against the active list (or, in fallback, the scaled-up share),
/// book it in the wallet's record and the vault, and return the amount to pay now.
#[allow(clippy::too_many_arguments)]
fn book_pay(
    v: &mut Vault,
    rec: &mut PaidRecord,
    record_bump: u8,
    wallet: &Pubkey,
    auth: &Pubkey,
    cumulative: u64,
    proof: &[[u8; 32]],
    fallback: bool,
) -> Result<u64> {
    let now = Clock::get()?.unix_timestamp;
    require_keys_neq!(*wallet, *auth, VaultError::WrongAccount);
    activate_if_due(v, now);
    if fallback {
        math::check_fallback(v.list_epoch, v.pending_epoch, v.last_publish_at, now)?;
    } else {
        require!(v.list_epoch > 0, VaultError::BadProof);
    }
    let vault_key = vault_pda(&v.mint, v.bump)?;
    require!(verify_proof(proof, &v.list_root, vault_leaf(&vault_key, wallet, cumulative)), VaultError::BadProof);
    if rec.vault == Pubkey::default() {
        rec.vault = vault_key;
        rec.wallet = *wallet;
        rec.paid = 0;
        rec.bump = record_bump;
    }
    if fallback {
        let f = math::fallback_pay(cumulative, v.holders_funded, v.list_total, rec.paid, v.holders_paid)?;
        rec.paid = f.entitled;
        v.holders_paid = add(v.holders_paid, f.amount)?;
        v.fallback_paid = add(v.fallback_paid, f.amount)?;
        emit!(FallbackPaid { vault: vault_key, wallet: *wallet, amount: f.amount, entitled: f.entitled });
        Ok(f.amount)
    } else {
        require!(cumulative > rec.paid, VaultError::NothingToPay);
        let amount = cumulative - rec.paid;
        let paid_total = add(v.holders_paid, amount)?;
        // A list can only divide what it allocated (and list_total <= holders_funded).
        require!(paid_total <= v.list_total && paid_total <= v.holders_funded, VaultError::OverFunded);
        rec.paid = cumulative;
        v.holders_paid = paid_total;
        emit!(Paid { vault: vault_key, wallet: *wallet, amount, cumulative });
        Ok(amount)
    }
}

fn pay_token_inner(ctx: Context<PayToken>, cumulative: u64, proof: Vec<[u8; 32]>, fallback: bool) -> Result<()> {
    let accs = ctx.accounts;
    require!(accs.vault.payout_pool != Pubkey::default(), VaultError::PaysInXnt);
    let payout_mint = accs.payout_mint.key();
    let payout_program = accs.payout_token_program.key();
    // The payout mint is the payout pool's non-wXNT side.
    let pool = PoolView::read(&accs.payout_pool.to_account_info())?;
    pool.pair_side(&payout_mint, &payout_program).map_err(|_| error!(VaultError::BadPayoutPool))?;
    let amount = book_pay(&mut accs.vault, &mut accs.record, ctx.bumps.record, &accs.wallet.key(), &accs.auth.key(), cumulative, &proof, fallback)?;

    let mint_key = accs.vault.mint;
    let auth_seeds: &[&[u8]] = &[b"auth", mint_key.as_ref(), &[accs.vault.auth_bump]];
    let ptok = accs.payout_token_program.to_account_info();
    create_ata(
        &accs.associated_token_program.to_account_info(),
        &accs.payer.to_account_info(),
        &accs.wallet_payout.to_account_info(),
        &accs.wallet.to_account_info(),
        &accs.payout_mint.to_account_info(),
        &accs.system_program.to_account_info(),
        &ptok,
    )?;
    let decimals = {
        let d = accs.payout_mint.try_borrow_data()?;
        StateWithExtensions::<MintState>::unpack(&d).map_err(|_| error!(VaultError::BadPayoutMint))?.base.decimals
    };
    let before = token_amount(&accs.wallet_payout.to_account_info(), &payout_program)?;
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ptok,
            token_interface::TransferChecked {
                from: accs.auth_payout.to_account_info(),
                mint: accs.payout_mint.to_account_info(),
                to: accs.wallet_payout.to_account_info(),
                authority: accs.auth.to_account_info(),
            },
            &[auth_seeds],
        ),
        amount,
        decimals,
    )?;
    // The wallet receives exactly the amount (no fee on the payout token).
    let got = token_amount(&accs.wallet_payout.to_account_info(), &payout_program)?.checked_sub(before).ok_or(VaultError::MathOverflow)?;
    require!(got == amount, VaultError::BadPayoutMint);
    check_payout_tokens(&accs.auth_payout.to_account_info(), &payout_program, &accs.vault)?;
    check_solvent(&accs.auth.to_account_info(), &accs.vault)
}

// ---------- Helpers ----------

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or_else(|| error!(VaultError::MathOverflow))
}

/// This program's ["vault", mint] PDA with its stored bump.
fn vault_pda(mint: &Pubkey, bump: u8) -> Result<Pubkey> {
    Pubkey::create_program_address(&[b"vault", mint.as_ref(), &[bump]], &crate::ID).map_err(|_| error!(VaultError::WrongAccount))
}

/// The checks every new vault passes (`init_vault` / `init_vault_payout`), and auth's
/// rent-exempt reserve (never promised to anyone), paid by `payer` if missing.
#[allow(clippy::too_many_arguments)]
fn check_init<'info>(
    burn_bps: u16,
    lp_bps: u16,
    mint: &AccountInfo<'info>,
    auth: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    instructions: &AccountInfo<'info>,
    pool: &AccountInfo<'info>,
    lock: &AccountInfo<'info>,
    creator_nft: &Pubkey,
    system: &AccountInfo<'info>,
) -> Result<()> {
    math::check_split(burn_bps, lp_bps)?;
    let update_authority = check_vault_mint(mint, auth.key)?;
    require!(
        update_authority == Some(*payer.key) || handover_in_tx(instructions, mint.key, auth.key)?,
        VaultError::BadAuthority
    );
    PoolView::read(pool)?.token_side(mint.key)?;
    check_lock(lock, creator_nft, pool.key)?;
    let reserve = Rent::get()?.minimum_balance(0);
    let have = auth.lamports();
    if have < reserve {
        system_program::transfer(
            CpiContext::new(system.clone(), system_program::Transfer { from: payer.clone(), to: auth.clone() }),
            reserve - have,
        )?;
    }
    Ok(())
}

/// A new vault's fields; `payout_pool` = Pubkey::default() pays holders in XNT.
#[allow(clippy::too_many_arguments)]
fn setup_vault(
    v: &mut Vault,
    mint: Pubkey,
    pool: Pubkey,
    creator_nft: Pubkey,
    publisher: Pubkey,
    guardian: Pubkey,
    burn_bps: u16,
    lp_bps: u16,
    bump: u8,
    auth_bump: u8,
    payout_pool: Pubkey,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    v.mint = mint;
    v.pool = pool;
    v.creator_nft = creator_nft;
    v.reward_mint = REWARD_MINT;
    v.reward_swap_pool = REWARD_POOL;
    v.publisher = publisher;
    v.guardian = guardian;
    v.burn_bps = burn_bps;
    v.lp_bps = lp_bps;
    v.creator_bps = CREATOR_BPS;
    v.pending_tokens = 0;
    v.lp_tokens = 0;
    v.sell_lp = 0;
    v.sell_creator = 0;
    v.sell_holders = 0;
    v.xnt_lp = 0;
    v.xnt_creator = 0;
    v.holders_funded = 0;
    v.holders_paid = 0;
    v.list_epoch = 0;
    v.list_root = [0; 32];
    v.list_total = 0;
    v.pending_epoch = 0;
    v.pending_root = [0; 32];
    v.pending_total = 0;
    v.pending_active_at = 0;
    v.total_collected = 0;
    v.total_burned = 0;
    v.total_lp_tokens = 0;
    v.total_lp_xnt = 0;
    v.total_creator_xnt = 0;
    v.total_crank_rewards = 0;
    v.created_at = now;
    v.bump = bump;
    v.auth_bump = auth_bump;
    v.last_sell_slot = 0;
    v.version = VAULT_VERSION;
    v.cancels_in_row = 0;
    v.total_reward_out = 0;
    v.last_reward_slot = 0;
    // The appoint / fallback clocks start at creation.
    v.last_publish_at = now;
    v.list_cid = [0; 33];
    v.pending_cid = [0; 33];
    v.fallback_paid = 0;
    v.payout_pool = payout_pool;
    v.xnt_holders = 0;
    v.reserved = [0; 20];
    Ok(())
}

/// A payout token: a mint of `program` (SPL Token or Token-2022) with no freeze authority
/// and only metadata / group extensions (no transfer fee, hook, delegate or pause), so the
/// vault's payout balance can't be frozen, taxed or moved by anyone else.
fn check_payout_mint(mint: &AccountInfo, program: &Pubkey) -> Result<()> {
    require!(*program == token::ID || *program == token_2022::ID, VaultError::BadPayoutMint);
    require_keys_eq!(*mint.owner, *program, VaultError::BadPayoutMint);
    let d = mint.try_borrow_data()?;
    payout_mint_ok(&d)
}

pub fn payout_mint_ok(data: &[u8]) -> Result<()> {
    reward_mint_ok(data).map_err(|_| error!(VaultError::BadPayoutMint))?;
    let state = StateWithExtensions::<MintState>::unpack(data).map_err(|_| error!(VaultError::BadPayoutMint))?;
    require!(state.base.freeze_authority.is_none(), VaultError::BadPayoutMint);
    Ok(())
}

/// auth's payout-token account holds at least what the holders are still owed.
fn check_payout_tokens(auth_payout: &AccountInfo, program: &Pubkey, v: &Vault) -> Result<()> {
    let owed = v.holders_funded.checked_sub(v.holders_paid).ok_or(VaultError::Insolvent)?;
    require!(token_amount(auth_payout, program)? >= owed, VaultError::Insolvent);
    Ok(())
}

/// A pending list whose time has come becomes the active one.
fn activate_if_due(v: &mut Vault, now: i64) {
    if v.pending_epoch != 0 && now >= v.pending_active_at {
        v.list_epoch = v.pending_epoch;
        v.list_root = v.pending_root;
        v.list_total = v.pending_total;
        v.pending_epoch = 0;
        v.pending_root = [0; 32];
        v.pending_total = 0;
        v.pending_active_at = 0;
        v.cancels_in_row = 0;
        v.list_cid = v.pending_cid;
        v.pending_cid = [0; 33];
    }
}

/// XNT promised by the vault (lamports that must stay in auth). A payout-token vault owes
/// its holders in tokens (checked separately) and only the XNT not yet swapped here.
pub fn promised(v: &Vault) -> Result<u64> {
    let owed = v.holders_funded.checked_sub(v.holders_paid).ok_or(VaultError::Insolvent)?;
    let holders = if v.payout_pool == Pubkey::default() { owed } else { v.xnt_holders };
    add(add(v.xnt_lp, v.xnt_creator)?, holders)
}

/// The lamport invariant: auth covers every bucket plus its own rent-exempt reserve.
fn check_solvent(auth: &AccountInfo, v: &Vault) -> Result<()> {
    let need = add(promised(v)?, Rent::get()?.minimum_balance(0))?;
    require!(auth.lamports() >= need, VaultError::Insolvent);
    Ok(())
}

/// auth's token account holds at least every token bucket.
fn check_tokens(auth_token: &AccountInfo, v: &Vault) -> Result<()> {
    let booked = add(add(add(add(v.pending_tokens, v.lp_tokens)?, v.sell_lp)?, v.sell_creator)?, v.sell_holders)?;
    require!(token_amount(auth_token, &token_2022::ID)? >= booked, VaultError::Insolvent);
    Ok(())
}

/// Offsets in the raw vault account (discriminator included), see the spec.
const V1_BUMP_OFFSET: usize = 470;
const REWARD_MINT_OFFSET: usize = 104;
const REWARD_SWAP_POOL_OFFSET: usize = 136;
const VERSION_OFFSET: usize = 480;
/// First byte after the v2 fields that v3 keeps (version .. last_reward_slot).
const V3_NEW_OFFSET: usize = 498;
const LAST_PUBLISH_AT_OFFSET: usize = 498;

/// Rewrite a v1 (480-byte) or v2 (552-byte) vault, already resized to 640 bytes, as v3.
/// `old_len` is its length before the resize. A v1 vault first gets the v2 rewrite: a clear
/// cancel counter / reward totals, and this network's reward token and pool. Then bytes
/// 498..640 are cleared, `version = 3` and `last_publish_at = now`. Every other old field
/// keeps its bytes (a v2 vault keeps all of 0..498 but the version byte).
pub fn upgrade_layout(d: &mut [u8], old_len: usize, now: i64) -> Result<()> {
    require!(d.len() == VAULT_V3_LEN && d[..8] == VAULT_DISC, VaultError::WrongVersion);
    match old_len {
        VAULT_V1_LEN => {
            d[REWARD_MINT_OFFSET..REWARD_MINT_OFFSET + 32].copy_from_slice(REWARD_MINT.as_ref());
            d[REWARD_SWAP_POOL_OFFSET..REWARD_SWAP_POOL_OFFSET + 32].copy_from_slice(REWARD_POOL.as_ref());
            d[VAULT_V1_LEN..].fill(0);
        }
        VAULT_V2_LEN => {
            require!(d[VERSION_OFFSET] == 2, VaultError::WrongVersion);
            d[V3_NEW_OFFSET..].fill(0);
        }
        _ => return err!(VaultError::WrongVersion),
    }
    d[VERSION_OFFSET] = VAULT_VERSION;
    d[LAST_PUBLISH_AT_OFFSET..LAST_PUBLISH_AT_OFFSET + 8].copy_from_slice(&now.to_le_bytes());
    Ok(())
}

/// The reward token must be a plain SPL Token / Token-2022 mint owned by `program`, with
/// no transfer fee (the swap output must be what lp_locker receives) and nothing that lets
/// anyone move, freeze, hook or pause its tokens: only metadata / group extensions.
fn check_reward_mint(mint: &AccountInfo, program: &Pubkey) -> Result<()> {
    require_keys_eq!(*mint.owner, *program, VaultError::BadRewardMint);
    reward_mint_ok(&mint.try_borrow_data()?)
}

pub fn reward_mint_ok(data: &[u8]) -> Result<()> {
    let state = StateWithExtensions::<MintState>::unpack(data).map_err(|_| error!(VaultError::BadRewardMint))?;
    require!(state.base.is_initialized, VaultError::BadRewardMint);
    for ext in state.get_extension_types().map_err(|_| error!(VaultError::BadRewardMint))? {
        require!(
            matches!(
                ext,
                ExtensionType::MetadataPointer
                    | ExtensionType::TokenMetadata
                    | ExtensionType::GroupPointer
                    | ExtensionType::GroupMemberPointer
                    | ExtensionType::TokenGroup
                    | ExtensionType::TokenGroupMember
            ),
            VaultError::BadRewardMint
        );
    }
    Ok(())
}

/// The mint must be a Token-2022 tax token that nobody can change or freeze: only the
/// TransferFeeConfig / MetadataPointer / TokenMetadata extensions, no freeze authority, a
/// fee of 1..9999 bps with no maximum and no fee-config authority, and `auth` as the withdraw-withheld
/// authority. Returns the metadata update authority (if any).
fn check_vault_mint(mint: &AccountInfo, auth: &Pubkey) -> Result<Option<Pubkey>> {
    require_keys_eq!(*mint.owner, token_2022::ID, VaultError::BadMint);
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data).map_err(|_| error!(VaultError::BadMint))?;
    require!(state.base.is_initialized, VaultError::BadMint);
    require!(state.base.freeze_authority.is_none(), VaultError::BadMint);
    for ext in state.get_extension_types().map_err(|_| error!(VaultError::BadMint))? {
        require!(
            matches!(ext, ExtensionType::TransferFeeConfig | ExtensionType::MetadataPointer | ExtensionType::TokenMetadata),
            VaultError::BadMint
        );
    }
    let cfg = state.get_extension::<TransferFeeConfig>().map_err(|_| error!(VaultError::BadMint))?;
    let cfg_authority: Option<Pubkey> = cfg.transfer_fee_config_authority.into();
    require!(cfg_authority.is_none(), VaultError::BadAuthority);
    let withdraw: Option<Pubkey> = cfg.withdraw_withheld_authority.into();
    require!(withdraw == Some(*auth), VaultError::BadAuthority);
    for f in [&cfg.older_transfer_fee, &cfg.newer_transfer_fee] {
        let bps = u16::from(f.transfer_fee_basis_points);
        require!(bps > 0 && u64::from(bps) < BPS, VaultError::BadMint);
        // No fee cap: the sale's impact limit (and so the sandwich protection) relies on
        // the full percentage being charged on large transfers.
        require!(u64::from(f.maximum_fee) == u64::MAX, VaultError::BadMint);
    }
    let update_authority = match state.get_variable_len_extension::<TokenMetadata>() {
        Ok(md) => Option::<Pubkey>::from(md.update_authority),
        Err(_) => None,
    };
    Ok(update_authority)
}

/// True when an earlier top-level instruction of this transaction is a Token-2022
/// SetAuthority(WithheldWithdraw -> auth) on `mint` (an atomic hand-over to the vault).
fn handover_in_tx(ixs: &AccountInfo, mint: &Pubkey, auth: &Pubkey) -> Result<bool> {
    require_keys_eq!(*ixs.key, ix_sysvar::ID, VaultError::WrongAccount);
    let current = ix_sysvar::load_current_index_checked(ixs)? as usize;
    for i in 0..current {
        let ix = ix_sysvar::load_instruction_at_checked(i, ixs)?;
        if ix.program_id != token_2022::ID || ix.accounts.first().map(|m| m.pubkey) != Some(*mint) {
            continue;
        }
        if let Ok(TokenInstruction::SetAuthority {
            authority_type: AuthorityType::WithheldWithdraw,
            new_authority: COption::Some(new),
        }) = TokenInstruction::unpack(&ix.data)
        {
            if new == *auth {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// The mint's transfer fee for `epoch`.
fn epoch_fee(mint: &AccountInfo, epoch: u64) -> Result<TransferFee> {
    require_keys_eq!(*mint.owner, token_2022::ID, VaultError::BadMint);
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data).map_err(|_| error!(VaultError::BadMint))?;
    let cfg = state.get_extension::<TransferFeeConfig>().map_err(|_| error!(VaultError::BadMint))?;
    Ok(*cfg.get_epoch_fee(epoch))
}

/// lp_locker `Lock` of `creator_nft`, for `pool`.
fn check_lock(lock: &AccountInfo, creator_nft: &Pubkey, pool: &Pubkey) -> Result<()> {
    require_keys_eq!(*lock.owner, LOCKER_PROGRAM_ID, VaultError::BadLock);
    let expected = Pubkey::find_program_address(&[b"lock", creator_nft.as_ref()], &LOCKER_PROGRAM_ID).0;
    require_keys_eq!(lock.key(), expected, VaultError::BadLock);
    let d = lock.try_borrow_data()?;
    require!(d.len() >= 72 && d[..8] == LOCKER_LOCK_DISC, VaultError::BadLock);
    require!(d[8..40] == creator_nft.to_bytes(), VaultError::BadLock);
    require!(d[40..72] == pool.to_bytes(), VaultError::BadLock);
    Ok(())
}

/// XDEX amm config trade fee rate (millionths).
fn read_trade_fee_rate(cfg: &AccountInfo) -> Result<u64> {
    require_keys_eq!(*cfg.owner, XDEX_PROGRAM_ID, VaultError::WrongAccount);
    let d = cfg.try_borrow_data()?;
    require!(d.len() == XDEX_CONFIG_LEN && d[..8] == XDEX_CONFIG_DISC, VaultError::WrongAccount);
    let rate = u64::from_le_bytes(d[12..20].try_into().unwrap());
    require!((rate as u128) < FEE_DENOM, VaultError::WrongAccount);
    Ok(rate)
}

/// Amount of an SPL Token / Token-2022 account owned by `program`.
fn token_amount(acc: &AccountInfo, program: &Pubkey) -> Result<u64> {
    require_keys_eq!(*acc.owner, *program, VaultError::WrongAccount);
    let d = acc.try_borrow_data()?;
    require!(d.len() >= 72, VaultError::WrongAccount);
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

fn pay_from_auth<'info>(
    system: &AccountInfo<'info>,
    auth: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new_with_signer(system.clone(), system_program::Transfer { from: auth.clone(), to: to.clone() }, &[seeds]),
        amount,
    )
}

/// Create `owner`'s ATA idempotently, paid by `payer` (a transaction signer). Returns the
/// lamports `payer` spent (0 when it already existed).
fn create_ata<'info>(
    ata_program: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    ata: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
) -> Result<u64> {
    let before = ata.lamports();
    associated_token::create_idempotent(CpiContext::new(
        ata_program.clone(),
        CreateIdempotent {
            payer: payer.clone(),
            associated_token: ata.clone(),
            authority: owner.clone(),
            mint: mint.clone(),
            system_program: system.clone(),
            token_program: token_program.clone(),
        },
    ))?;
    Ok(ata.lamports().saturating_sub(before))
}

fn ata(owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, program)
}

/// The parts of an XDEX PoolState this program needs (same layout as lp_locker's PoolView
/// and decodePool in src/xdex.ts).
struct PoolView {
    amm_config: Pubkey,
    vaults: [Pubkey; 2],
    lp_mint: Pubkey,
    mints: [Pubkey; 2],
    programs: [Pubkey; 2],
    observation: Pubkey,
    status: u8,
    lp_supply: u64,
    protocol_fees: [u64; 2],
    fund_fees: [u64; 2],
}

impl PoolView {
    fn read(acc: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*acc.owner, XDEX_PROGRAM_ID, VaultError::BadPool);
        let d = acc.try_borrow_data()?;
        require!(d.len() == XDEX_POOL_LEN && d[..8] == XDEX_POOL_DISC, VaultError::BadPool);
        let key = |i: usize| Pubkey::new_from_array(d[8 + i * 32..40 + i * 32].try_into().unwrap());
        let u64_at = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
        Ok(Self {
            amm_config: key(0),
            vaults: [key(2), key(3)],
            lp_mint: key(4),
            mints: [key(5), key(6)],
            programs: [key(7), key(8)],
            observation: key(9),
            status: d[329],
            lp_supply: u64_at(333),
            protocol_fees: [u64_at(341), u64_at(349)],
            fund_fees: [u64_at(357), u64_at(365)],
        })
    }

    /// Index of `mint` in the pool; the pool must be `mint` (Token-2022) / wXNT (SPL Token).
    fn token_side(&self, mint: &Pubkey) -> Result<usize> {
        self.pair_side(mint, &token_2022::ID)
    }

    /// Index of `mint` in the pool; the pool must be `mint` (owned by `program`) / wXNT
    /// (SPL Token).
    fn pair_side(&self, mint: &Pubkey, program: &Pubkey) -> Result<usize> {
        let side = if self.mints[0] == *mint {
            0
        } else if self.mints[1] == *mint {
            1
        } else {
            return err!(VaultError::BadPool);
        };
        require_keys_eq!(self.mints[1 - side], native_mint::ID, VaultError::BadPool);
        require_keys_eq!(self.programs[side], *program, VaultError::BadPool);
        require_keys_eq!(self.programs[1 - side], token::ID, VaultError::BadPool);
        Ok(side)
    }

    /// Reserve of side `i`, net of protocol and fund fees (as XDEX prices trades).
    fn reserve(&self, i: usize, vault: &AccountInfo) -> Result<u64> {
        require_keys_eq!(self.vaults[i], vault.key(), VaultError::WrongAccount);
        let fees = self.protocol_fees[i].checked_add(self.fund_fees[i]).ok_or(VaultError::MathOverflow)?;
        let r = token_amount(vault, &self.programs[i])?.checked_sub(fees).ok_or(VaultError::MathOverflow)?;
        require!(r > 0, VaultError::BadPool);
        Ok(r)
    }
}

// ---------- Merkle list ----------

/// Leaf of the rewards list: sha256("99tax-vault" || vault || wallet || cumulative_u64_le).
/// The prefix makes a leaf (83 bytes hashed) unable to collide with an inner node (64).
pub fn vault_leaf(vault: &Pubkey, wallet: &Pubkey, cumulative: u64) -> [u8; 32] {
    hashv(&[LEAF_PREFIX, vault.as_ref(), wallet.as_ref(), &cumulative.to_le_bytes()]).to_bytes()
}

/// Sorted-pair Merkle proof: at each level hash the smaller node first.
pub fn verify_proof(proof: &[[u8; 32]], root: &[u8; 32], leaf: [u8; 32]) -> bool {
    let mut h = leaf;
    for p in proof {
        h = if h <= *p { hashv(&[&h, p]) } else { hashv(&[p, &h]) }.to_bytes();
    }
    &h == root
}

// ---------- Maths (pure, unit-tested) ----------

pub mod math {
    use super::*;

    fn to_u64(v: u128) -> Result<u64> {
        u64::try_from(v).map_err(|_| error!(VaultError::MathOverflow))
    }

    pub fn check_split(burn_bps: u16, lp_bps: u16) -> Result<()> {
        require!(
            burn_bps <= MAX_BURN_BPS && lp_bps <= MAX_LP_BPS && (burn_bps as u32 + lp_bps as u32) <= MAX_BURN_PLUS_LP_BPS as u32,
            VaultError::BadSplit
        );
        Ok(())
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Split {
        pub burn: u64,
        pub lp: u64,
        pub creator: u64,
        pub holders: u64,
    }

    /// Floors for burn/LP/creator; holders get the rest (so the parts sum to `got`).
    pub fn split(got: u64, burn_bps: u16, lp_bps: u16, creator_bps: u16) -> Result<Split> {
        let part = |bps: u16| (got as u128 * bps as u128 / BPS as u128) as u64;
        let (burn, lp, creator) = (part(burn_bps), part(lp_bps), part(creator_bps));
        let holders = got
            .checked_sub(burn)
            .and_then(|r| r.checked_sub(lp))
            .and_then(|r| r.checked_sub(creator))
            .ok_or(VaultError::BadSplit)?;
        Ok(Split { burn, lp, creator, holders })
    }

    /// Price-impact cap for a token with `tax_bps` transfer tax: MAX_IMPACT_BPS, and at
    /// most half the tax. A sandwich (dump, vault sale, buy back) costs the attacker about
    /// the tax twice on their own size, while the vault loses about 2x its sale's relative
    /// size; keeping the sale's impact under the tax makes that unprofitable.
    pub fn impact_bps(tax_bps: u64) -> u64 {
        MAX_IMPACT_BPS.min(tax_bps / 2)
    }

    /// Largest pre-transfer-fee input whose net amount moves the price at most
    /// `impact_bps` (mirrors maxInputForImpact in src/xdex.ts, with the fee cap).
    pub fn max_input_for_impact(reserve_in: u64, impact_bps: u64, fee_bps: u64, max_fee: u64) -> Result<u64> {
        if impact_bps == 0 || impact_bps >= BPS || fee_bps >= BPS {
            return Ok(0);
        }
        let net = reserve_in as u128 * impact_bps as u128 / (BPS - impact_bps) as u128;
        let gross = (net * BPS as u128 / (BPS - fee_bps) as u128).min(net + max_fee as u128);
        Ok(to_u64(gross.min(u64::MAX as u128))?)
    }

    /// Constant-product output for `net_in` (after the transfer fee), trade fee rounded up
    /// (mirrors cpmmOut in src/xdex.ts and XDEX's swap_base_input).
    pub fn cpmm_out(net_in: u64, reserve_in: u64, reserve_out: u64, trade_fee_rate: u64) -> Result<u64> {
        let fee = (net_in as u128 * trade_fee_rate as u128).div_ceil(FEE_DENOM);
        let after = (net_in as u128).checked_sub(fee).ok_or(VaultError::MathOverflow)?;
        let den = reserve_in as u128 + after;
        require!(den > 0, VaultError::BadPool);
        to_u64(after * reserve_out as u128 / den)
    }

    /// Impact cap of a reward swap (XNT -> reward token, no transfer tax): at most
    /// REWARD_MAX_IMPACT_BPS and at most half the pool's trade fee (millionths / 100 = bps).
    /// A sandwich pays the trade fee twice on the attacker's size and gains about twice the
    /// swap's relative size, so keeping the impact under the fee makes it unprofitable.
    pub fn reward_impact_bps(trade_fee_rate: u64) -> u64 {
        REWARD_MAX_IMPACT_BPS.min(trade_fee_rate / 200)
    }

    /// XNT going into one reward swap: all of `xnt_creator` up to the impact cap.
    pub fn reward_swap_in(xnt_creator: u64, reserve_xnt: u64, trade_fee_rate: u64) -> Result<u64> {
        let cap = max_input_for_impact(reserve_xnt, reward_impact_bps(trade_fee_rate), 0, u64::MAX)?;
        Ok(xnt_creator.min(cap))
    }

    /// The guardian's cancel counter after one more cancel (TooManyCancels past the limit).
    pub fn next_cancel(cancels_in_row: u8) -> Result<u8> {
        require!(cancels_in_row < MAX_CANCELS_IN_ROW, VaultError::TooManyCancels);
        Ok(cancels_in_row + 1)
    }

    pub fn min_out(expected: u64) -> Result<u64> {
        to_u64(expected as u128 * (BPS - OUT_TOLERANCE_BPS) as u128 / BPS as u128)
    }

    /// What `fund_creator` deposits for the creator: everything auth's reward account holds
    /// after the swap (`held`) except `keep`, the holders' tokens when that account is also
    /// their payout account (zero otherwise). The holders' tokens must already have been
    /// there before the swap (`before`).
    pub fn creator_deposit(before: u64, held: u64, keep: u64) -> Result<u64> {
        require!(held >= before, VaultError::MathOverflow);
        require!(before >= keep, VaultError::Insolvent);
        Ok(held - keep)
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Take {
        pub lp: u64,
        pub creator: u64,
        pub holders: u64,
    }

    /// Take `amount` from the three sell buckets pro-rata (floors for LP and creator, the
    /// rest from holders), never more than a bucket holds.
    pub fn take(amount: u64, lp: u64, creator: u64, holders: u64) -> Result<Take> {
        let total = lp as u128 + creator as u128 + holders as u128;
        require!(amount > 0 && (amount as u128) <= total, VaultError::TooSmall);
        let mut t_lp = (amount as u128 * lp as u128 / total) as u64;
        let mut t_cr = (amount as u128 * creator as u128 / total) as u64;
        let mut t_ho = amount - t_lp - t_cr;
        if t_ho > holders {
            let mut excess = t_ho - holders;
            t_ho = holders;
            let more = excess.min(lp - t_lp);
            t_lp += more;
            excess -= more;
            let more = excess.min(creator - t_cr);
            t_cr += more;
            excess -= more;
            require!(excess == 0, VaultError::MathOverflow);
        }
        Ok(Take { lp: t_lp, creator: t_cr, holders: t_ho })
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Proceeds {
        pub lp: u64,
        pub creator: u64,
        /// Holders' part including the crank reward.
        pub holders: u64,
        pub reward: u64,
    }

    /// Split the XNT out of a sale pro-rata to the tokens taken from each bucket
    /// (rounding to holders), and the caller's reward out of the holders' part.
    pub fn proceeds(out: u64, amount: u64, t: &Take) -> Result<Proceeds> {
        require!(amount > 0 && t.lp + t.creator + t.holders == amount, VaultError::MathOverflow);
        let lp = (out as u128 * t.lp as u128 / amount as u128) as u64;
        let creator = (out as u128 * t.creator as u128 / amount as u128) as u64;
        let holders = out - lp - creator;
        let reward = ((holders as u128 * CRANK_REWARD_BPS as u128 / BPS as u128) as u64).min(CRANK_REWARD_CAP);
        Ok(Proceeds { lp, creator, holders, reward })
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Deposit {
        pub lp: u64,
        /// Tokens leaving auth (transfer fee included).
        pub tokens: u64,
        pub xnt: u64,
    }

    /// Token and XNT the pool takes for `lp` LP tokens, rounded up as XDEX does.
    pub fn deposit_amounts(lp: u64, reserve_token: u64, reserve_xnt: u64, lp_supply: u64) -> Result<(u64, u64)> {
        require!(lp_supply > 0, VaultError::BadPool);
        let s = lp_supply as u128;
        Ok((
            to_u64((lp as u128 * reserve_token as u128).div_ceil(s))?,
            to_u64((lp as u128 * reserve_xnt as u128).div_ceil(s))?,
        ))
    }

    /// Largest LP amount whose deposit (transfer fee included, via `inverse_fee`) fits in
    /// `tokens` and `xnt` (mirrors maxLpFor in src/xdex.ts). None if nothing fits.
    pub fn deposit_for(
        tokens: u64,
        xnt: u64,
        reserve_token: u64,
        reserve_xnt: u64,
        lp_supply: u64,
        inverse_fee: impl Fn(u64) -> Option<u64>,
    ) -> Result<Option<Deposit>> {
        if tokens == 0 || xnt == 0 || lp_supply == 0 || reserve_token == 0 || reserve_xnt == 0 {
            return Ok(None);
        }
        let s = lp_supply as u128;
        let by_token = tokens as u128 * s / reserve_token as u128;
        let by_xnt = xnt as u128 * s / reserve_xnt as u128;
        let mut lp = to_u64(by_token.min(by_xnt).min(u64::MAX as u128))?;
        for _ in 0..64 {
            if lp == 0 {
                break;
            }
            let (need_t, need_x) = deposit_amounts(lp, reserve_token, reserve_xnt, lp_supply)?;
            let gross = inverse_fee(need_t).and_then(|f| need_t.checked_add(f)).unwrap_or(u64::MAX);
            if gross <= tokens && need_x <= xnt && need_t > 0 && need_x > 0 {
                return Ok(Some(Deposit { lp, tokens: gross, xnt: need_x }));
            }
            // Scale down by the larger overshoot (the transfer fee makes the first estimate
            // too big on the token side), then step down by rounding units.
            let mut next = lp as u128;
            if gross > tokens {
                next = next.min(lp as u128 * tokens as u128 / gross as u128);
            }
            if need_x > xnt {
                next = next.min(lp as u128 * xnt as u128 / need_x as u128);
            }
            lp = (next as u64).min(lp - 1);
        }
        Ok(None)
    }

    /// Rules for a new list: newer epoch, total never lower (than the active and pending
    /// lists, and than what was already paid, which fallback payments can push above the
    /// list total), never above what the holders' share has received.
    #[allow(clippy::too_many_arguments)]
    pub fn check_publish(
        list_epoch: u64,
        pending_epoch: u64,
        list_total: u64,
        pending_total: u64,
        holders_funded: u64,
        holders_paid: u64,
        epoch: u64,
        total: u64,
    ) -> Result<()> {
        require!(epoch > list_epoch.max(pending_epoch), VaultError::StaleEpoch);
        require!(total >= list_total.max(pending_total).max(holders_paid), VaultError::TotalDecreased);
        require!(total <= holders_funded, VaultError::OverFunded);
        Ok(())
    }

    /// The guardian may appoint a publisher only after APPOINT_AFTER_SECS without a publish.
    pub fn check_appoint(last_publish_at: i64, now: i64) -> Result<()> {
        require!(now >= last_publish_at.saturating_add(APPOINT_AFTER_SECS), VaultError::PublisherActive);
        Ok(())
    }

    /// Fallback payments need an active list, nothing pending, and FALLBACK_AFTER_SECS
    /// without a publish.
    pub fn check_fallback(list_epoch: u64, pending_epoch: u64, last_publish_at: i64, now: i64) -> Result<()> {
        require!(
            list_epoch > 0 && pending_epoch == 0 && now >= last_publish_at.saturating_add(FALLBACK_AFTER_SECS),
            VaultError::FallbackNotActive
        );
        Ok(())
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Fallback {
        /// What the wallet may have been paid in all: floor(cumulative * funded / list_total).
        pub entitled: u64,
        /// Paid now: entitled - record.paid.
        pub amount: u64,
    }

    /// A fallback payment: the wallet's list share scaled up to everything funded (u128,
    /// rounded down), minus what it was paid; payments in all never exceed `holders_funded`.
    pub fn fallback_pay(cumulative: u64, holders_funded: u64, list_total: u64, record_paid: u64, holders_paid: u64) -> Result<Fallback> {
        let entitled = if list_total == 0 {
            0
        } else {
            to_u64(cumulative as u128 * holders_funded as u128 / list_total as u128)?
        };
        require!(entitled > record_paid, VaultError::NothingToPay);
        let amount = entitled - record_paid;
        let paid_total = holders_paid.checked_add(amount).ok_or(VaultError::MathOverflow)?;
        require!(paid_total <= holders_funded, VaultError::OverFunded);
        Ok(Fallback { entitled, amount })
    }
}

// ---------- State ----------

/// The vault (v3 layout). Not `#[account]`: its deserializer refuses a v1 (480-byte), v2
/// (552-byte) or other-version vault with `WrongVersion` instead of a generic Anchor error, so every
/// instruction taking `Account<Vault>` requires an upgraded vault.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Vault {
    pub mint: Pubkey,
    /// XDEX TOKEN/wXNT pool.
    pub pool: Pubkey,
    /// lp_locker lock NFT of this pool (creator reward vault key).
    pub creator_nft: Pubkey,
    /// v1: NATIVE_MINT.
    pub reward_mint: Pubkey,
    /// v1: Pubkey::default().
    pub reward_swap_pool: Pubkey,
    /// May publish rewards lists.
    pub publisher: Pubkey,
    /// May cancel a pending list (the creator).
    pub guardian: Pubkey,
    pub burn_bps: u16,
    pub lp_bps: u16,
    pub creator_bps: u16,
    /// Reserved; always 0 in v1.
    pub pending_tokens: u64,
    /// Auto-LP tokens kept as tokens (half of the LP share).
    pub lp_tokens: u64,
    /// Tokens to sell for the LP's XNT side.
    pub sell_lp: u64,
    /// Tokens to sell for the creator reward.
    pub sell_creator: u64,
    /// Tokens to sell for holders.
    pub sell_holders: u64,
    pub xnt_lp: u64,
    pub xnt_creator: u64,
    /// Cumulative XNT ever added to the holder pool.
    pub holders_funded: u64,
    /// Cumulative XNT ever paid to holders.
    pub holders_paid: u64,
    pub list_epoch: u64,
    pub list_root: [u8; 32],
    /// Cumulative XNT allocated by the active list.
    pub list_total: u64,
    /// 0 = none pending.
    pub pending_epoch: u64,
    pub pending_root: [u8; 32],
    pub pending_total: u64,
    pub pending_active_at: i64,
    pub total_collected: u64,
    pub total_burned: u64,
    pub total_lp_tokens: u64,
    pub total_lp_xnt: u64,
    pub total_creator_xnt: u64,
    pub total_crank_rewards: u64,
    pub created_at: i64,
    pub bump: u8,
    pub auth_bump: u8,
    /// Slot of the last `sell` (one sale per slot).
    pub last_sell_slot: u64,
    // ----- v2 (appended; offset 480) -----
    /// Layout version: 3.
    pub version: u8,
    /// Guardian cancels since the last list went live.
    pub cancels_in_row: u8,
    /// Reward tokens ever deposited for the creator.
    pub total_reward_out: u64,
    /// Slot of the last reward swap in `fund_creator` (one per slot).
    pub last_reward_slot: u64,
    // ----- v3 (offset 498, over the v2 reserved bytes) -----
    /// Unix time of the last `publish_list` (or of creation / the v3 upgrade).
    pub last_publish_at: i64,
    /// IPFS address of the active list file: [codec, sha256 digest]; zero = none.
    pub list_cid: [u8; 33],
    /// IPFS address of the pending list file.
    pub pending_cid: [u8; 33],
    /// Paid by `pay_fallback`, ever (in the holder pool's unit).
    pub fallback_paid: u64,
    // ----- payout token (offset 580, over v3 reserved bytes; zero in older vaults) -----
    /// The payout token's XDEX pool against wXNT, fixed at creation; Pubkey::default() =
    /// holders are paid in XNT. With a payout token, holders_funded / holders_paid / list
    /// totals / PaidRecord.paid are in its base units.
    pub payout_pool: Pubkey,
    /// Holders' XNT not yet swapped into the payout token (payout-token vaults only).
    pub xnt_holders: u64,
    /// Future use (zero).
    pub reserved: [u8; 20],
}

impl Discriminator for Vault {
    const DISCRIMINATOR: &'static [u8] = &VAULT_DISC;
}

impl Owner for Vault {
    fn owner() -> Pubkey {
        crate::ID
    }
}

impl AccountSerialize for Vault {
    fn try_serialize<W: std::io::Write>(&self, writer: &mut W) -> Result<()> {
        writer.write_all(&VAULT_DISC).map_err(|_| error!(anchor_lang::error::ErrorCode::AccountDidNotSerialize))?;
        AnchorSerialize::serialize(self, writer).map_err(|_| error!(anchor_lang::error::ErrorCode::AccountDidNotSerialize))
    }
}

impl AccountDeserialize for Vault {
    fn try_deserialize(buf: &mut &[u8]) -> Result<Self> {
        if buf.len() < 8 {
            return err!(anchor_lang::error::ErrorCode::AccountDiscriminatorNotFound);
        }
        if buf[..8] != VAULT_DISC {
            return err!(anchor_lang::error::ErrorCode::AccountDiscriminatorMismatch);
        }
        if buf.len() < VAULT_V3_LEN || buf[VERSION_OFFSET] != VAULT_VERSION {
            return err!(VaultError::WrongVersion);
        }
        Self::try_deserialize_unchecked(buf)
    }

    fn try_deserialize_unchecked(buf: &mut &[u8]) -> Result<Self> {
        let mut data: &[u8] = &buf[8..];
        AnchorDeserialize::deserialize(&mut data).map_err(|_| error!(anchor_lang::error::ErrorCode::AccountDidNotDeserialize))
    }
}

#[account]
#[derive(InitSpace)]
pub struct PaidRecord {
    pub vault: Pubkey,
    pub wallet: Pubkey,
    /// Cumulative XNT paid to this wallet.
    pub paid: u64,
    pub bump: u8,
}

// ---------- Accounts ----------

#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: validated in check_vault_mint.
    pub mint: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + Vault::INIT_SPACE, seeds = [b"vault", mint.key().as_ref()], bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [b"auth", mint.key().as_ref()], bump)]
    pub auth: SystemAccount<'info>,
    /// CHECK: XDEX pool, checked in PoolView::read / token_side.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: lp_locker PDA(["lock", creator_nft]), checked in check_lock.
    pub lock: UncheckedAccount<'info>,
    /// CHECK: the lock's NFT mint (check_lock).
    pub creator_nft: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: the instructions sysvar (handover_in_tx).
    #[account(address = ix_sysvar::ID @ VaultError::WrongAccount)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitVaultPayout<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: validated in check_vault_mint.
    pub mint: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + Vault::INIT_SPACE, seeds = [b"vault", mint.key().as_ref()], bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [b"auth", mint.key().as_ref()], bump)]
    pub auth: SystemAccount<'info>,
    /// CHECK: XDEX pool, checked in PoolView::read / token_side.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: lp_locker PDA(["lock", creator_nft]), checked in check_lock.
    pub lock: UncheckedAccount<'info>,
    /// CHECK: the lock's NFT mint (check_lock).
    pub creator_nft: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: the instructions sysvar (handover_in_tx).
    #[account(address = ix_sysvar::ID @ VaultError::WrongAccount)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: the payout token (check_payout_mint).
    pub payout_mint: UncheckedAccount<'info>,
    /// CHECK: the payout token's XDEX pool against wXNT (PoolView::read / pair_side).
    pub payout_pool: UncheckedAccount<'info>,
    /// The payout mint's token program (SPL Token or Token-2022).
    pub payout_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Collect<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [b"auth", vault.mint.as_ref()], bump = vault.auth_bump)]
    pub auth: SystemAccount<'info>,
    /// CHECK: the vault's mint.
    #[account(mut, address = vault.mint @ VaultError::WrongAccount)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: ATA(auth, mint, Token-2022), created here if needed.
    #[account(mut, address = ata(&auth.key(), &vault.mint, &token_2022::ID) @ VaultError::WrongAccount)]
    pub auth_token: UncheckedAccount<'info>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [b"auth", vault.mint.as_ref()], bump = vault.auth_bump)]
    pub auth: SystemAccount<'info>,
    /// CHECK: the vault's mint.
    #[account(address = vault.mint @ VaultError::WrongAccount)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: ATA(auth, mint, Token-2022).
    #[account(mut, address = ata(&auth.key(), &vault.mint, &token_2022::ID) @ VaultError::WrongAccount)]
    pub auth_token: UncheckedAccount<'info>,
    /// CHECK: ATA(auth, NATIVE_MINT, SPL Token), created and closed here.
    #[account(mut, address = ata(&auth.key(), &native_mint::ID, &token::ID) @ VaultError::WrongAccount)]
    pub auth_wxnt: UncheckedAccount<'info>,
    /// CHECK: the vault's pool (layout checked in PoolView::read).
    #[account(mut, address = vault.pool @ VaultError::WrongAccount)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: must be the pool's amm config (checked in the handler).
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: XDEX vault/LP authority PDA; XDEX verifies it.
    pub xdex_authority: UncheckedAccount<'info>,
    /// CHECK: the pool's token vault (PoolView::reserve).
    #[account(mut)]
    pub token_vault: UncheckedAccount<'info>,
    /// CHECK: the pool's wXNT vault (PoolView::reserve).
    #[account(mut)]
    pub wxnt_vault: UncheckedAccount<'info>,
    /// CHECK: the pool's observation account (checked in the handler).
    #[account(mut)]
    pub observation: UncheckedAccount<'info>,
    /// CHECK: the XDEX program this build targets.
    #[account(address = XDEX_PROGRAM_ID @ VaultError::WrongAccount)]
    pub xdex_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: wrapped XNT mint.
    #[account(address = native_mint::ID @ VaultError::WrongAccount)]
    pub native_mint: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [b"auth", vault.mint.as_ref()], bump = vault.auth_bump)]
    pub auth: SystemAccount<'info>,
    /// CHECK: the vault's mint.
    #[account(address = vault.mint @ VaultError::WrongAccount)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: ATA(auth, mint, Token-2022).
    #[account(mut, address = ata(&auth.key(), &vault.mint, &token_2022::ID) @ VaultError::WrongAccount)]
    pub auth_token: UncheckedAccount<'info>,
    /// CHECK: ATA(auth, NATIVE_MINT, SPL Token), created and closed here.
    #[account(mut, address = ata(&auth.key(), &native_mint::ID, &token::ID) @ VaultError::WrongAccount)]
    pub auth_wxnt: UncheckedAccount<'info>,
    /// CHECK: ATA(auth, lp_mint, SPL Token), created and closed here.
    #[account(mut, address = ata(&auth.key(), &lp_mint.key(), &token::ID) @ VaultError::WrongAccount)]
    pub auth_lp: UncheckedAccount<'info>,
    /// CHECK: the vault's pool (layout checked in PoolView::read).
    #[account(mut, address = vault.pool @ VaultError::WrongAccount)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: XDEX vault/LP authority PDA; XDEX verifies it.
    pub xdex_authority: UncheckedAccount<'info>,
    /// CHECK: the pool's token vault (PoolView::reserve).
    #[account(mut)]
    pub token_vault: UncheckedAccount<'info>,
    /// CHECK: the pool's wXNT vault (PoolView::reserve).
    #[account(mut)]
    pub wxnt_vault: UncheckedAccount<'info>,
    /// CHECK: the pool's LP mint (checked in the handler).
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: the XDEX program this build targets.
    #[account(address = XDEX_PROGRAM_ID @ VaultError::WrongAccount)]
    pub xdex_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    /// CHECK: SPL Memo (kept for the spec's account order; XDEX deposit doesn't use it).
    #[account(address = MEMO_PROGRAM_ID @ VaultError::WrongAccount)]
    pub memo_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: wrapped XNT mint.
    #[account(address = native_mint::ID @ VaultError::WrongAccount)]
    pub native_mint: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FundCreator<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [b"auth", vault.mint.as_ref()], bump = vault.auth_bump)]
    pub auth: SystemAccount<'info>,
    /// CHECK: ATA(auth, NATIVE_MINT, SPL Token), created and closed here.
    #[account(mut, address = ata(&auth.key(), &native_mint::ID, &token::ID) @ VaultError::WrongAccount)]
    pub auth_wxnt: UncheckedAccount<'info>,
    /// CHECK: the vault's lock NFT.
    #[account(address = vault.creator_nft @ VaultError::WrongAccount)]
    pub creator_nft: UncheckedAccount<'info>,
    /// CHECK: the vault's reward mint (check_reward_mint).
    #[account(address = vault.reward_mint @ VaultError::BadRewardMint)]
    pub reward_mint: UncheckedAccount<'info>,
    /// CHECK: lp_locker PDA(["reward", creator_nft, reward_mint]) (checked in the handler).
    #[account(mut)]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: lp_locker PDA(["reward_tokens", reward_vault]) (checked in the handler).
    #[account(mut)]
    pub reward_tokens: UncheckedAccount<'info>,
    /// CHECK: the lp_locker program.
    #[account(address = LOCKER_PROGRAM_ID @ VaultError::WrongAccount)]
    pub locker_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: lp_locker PDA(["lock", creator_nft]) (checked in the handler; used by init_reward_vault).
    pub lock: UncheckedAccount<'info>,
    pub token_2022_program: Program<'info, Token2022>,
    /// CHECK: ATA(auth, reward_mint, reward_token_program), created and closed here.
    #[account(mut, address = ata(&auth.key(), &vault.reward_mint, &reward_token_program.key()) @ VaultError::WrongAccount)]
    pub auth_reward: UncheckedAccount<'info>,
    /// CHECK: the vault's reward swap pool (layout checked in PoolView::read).
    #[account(mut, address = vault.reward_swap_pool @ VaultError::WrongAccount)]
    pub reward_pool: UncheckedAccount<'info>,
    /// CHECK: must be the reward pool's amm config (checked in the handler).
    pub reward_amm_config: UncheckedAccount<'info>,
    /// CHECK: XDEX vault/LP authority PDA; XDEX verifies it.
    pub xdex_authority: UncheckedAccount<'info>,
    /// CHECK: the reward pool's reward-token vault (PoolView::reserve).
    #[account(mut)]
    pub reward_pool_reward_vault: UncheckedAccount<'info>,
    /// CHECK: the reward pool's wXNT vault (PoolView::reserve).
    #[account(mut)]
    pub reward_pool_wxnt_vault: UncheckedAccount<'info>,
    /// CHECK: the reward pool's observation account (checked in the handler).
    #[account(mut)]
    pub reward_observation: UncheckedAccount<'info>,
    /// CHECK: the XDEX program this build targets.
    #[account(address = XDEX_PROGRAM_ID @ VaultError::WrongAccount)]
    pub xdex_program: UncheckedAccount<'info>,
    /// CHECK: wrapped XNT mint.
    #[account(address = native_mint::ID @ VaultError::WrongAccount)]
    pub native_mint: UncheckedAccount<'info>,
    /// The reward mint's token program (SPL Token or Token-2022).
    pub reward_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct FundHolders<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [b"auth", vault.mint.as_ref()], bump = vault.auth_bump)]
    pub auth: SystemAccount<'info>,
    /// CHECK: ATA(auth, NATIVE_MINT, SPL Token), created and closed here.
    #[account(mut, address = ata(&auth.key(), &native_mint::ID, &token::ID) @ VaultError::WrongAccount)]
    pub auth_wxnt: UncheckedAccount<'info>,
    /// CHECK: the payout token (check_payout_mint; must be the payout pool's other side).
    pub payout_mint: UncheckedAccount<'info>,
    /// CHECK: ATA(auth, payout_mint, payout_token_program), created here once and kept.
    #[account(mut, address = ata(&auth.key(), &payout_mint.key(), &payout_token_program.key()) @ VaultError::WrongAccount)]
    pub auth_payout: UncheckedAccount<'info>,
    /// CHECK: the vault's payout pool (layout checked in PoolView::read).
    #[account(mut, address = vault.payout_pool @ VaultError::WrongAccount)]
    pub payout_pool: UncheckedAccount<'info>,
    /// CHECK: must be the payout pool's amm config (checked in the handler).
    pub payout_amm_config: UncheckedAccount<'info>,
    /// CHECK: XDEX vault/LP authority PDA; XDEX verifies it.
    pub xdex_authority: UncheckedAccount<'info>,
    /// CHECK: the payout pool's payout-token vault (PoolView::reserve).
    #[account(mut)]
    pub payout_pool_payout_vault: UncheckedAccount<'info>,
    /// CHECK: the payout pool's wXNT vault (PoolView::reserve).
    #[account(mut)]
    pub payout_pool_wxnt_vault: UncheckedAccount<'info>,
    /// CHECK: the payout pool's observation account (checked in the handler).
    #[account(mut)]
    pub payout_observation: UncheckedAccount<'info>,
    /// CHECK: the XDEX program this build targets.
    #[account(address = XDEX_PROGRAM_ID @ VaultError::WrongAccount)]
    pub xdex_program: UncheckedAccount<'info>,
    /// CHECK: wrapped XNT mint.
    #[account(address = native_mint::ID @ VaultError::WrongAccount)]
    pub native_mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// The payout mint's token program (SPL Token or Token-2022).
    pub payout_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpgradeVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: a v1 or v2 vault of this program, read as raw bytes (checked in the handler).
    #[account(mut, owner = crate::ID @ VaultError::WrongAccount)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PublishList<'info> {
    pub publisher: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
}

#[derive(Accounts)]
pub struct CancelList<'info> {
    pub guardian: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
}

#[derive(Accounts)]
pub struct SetPublisher<'info> {
    pub publisher: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
}

#[derive(Accounts)]
pub struct AppointPublisher<'info> {
    pub guardian: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
}

/// Accounts of `pay` and `pay_fallback`.
#[derive(Accounts)]
pub struct Pay<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [b"auth", vault.mint.as_ref()], bump = vault.auth_bump)]
    pub auth: SystemAccount<'info>,
    /// CHECK: any wallet; it only receives lamports.
    #[account(mut)]
    pub wallet: UncheckedAccount<'info>,
    #[account(
        init_if_needed, payer = payer, space = 8 + PaidRecord::INIT_SPACE,
        seeds = [b"paid", vault.key().as_ref(), wallet.key().as_ref()], bump,
    )]
    pub record: Box<Account<'info, PaidRecord>>,
    pub system_program: Program<'info, System>,
}

/// Accounts of `pay_token` and `pay_fallback_token`.
#[derive(Accounts)]
pub struct PayToken<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [b"auth", vault.mint.as_ref()], bump = vault.auth_bump)]
    pub auth: SystemAccount<'info>,
    /// CHECK: any wallet; it owns the account that receives the payout.
    pub wallet: UncheckedAccount<'info>,
    #[account(
        init_if_needed, payer = payer, space = 8 + PaidRecord::INIT_SPACE,
        seeds = [b"paid", vault.key().as_ref(), wallet.key().as_ref()], bump,
    )]
    pub record: Box<Account<'info, PaidRecord>>,
    /// CHECK: the vault's payout pool (read to check the payout mint).
    #[account(address = vault.payout_pool @ VaultError::WrongAccount)]
    pub payout_pool: UncheckedAccount<'info>,
    /// CHECK: the payout token: the payout pool's non-wXNT side (checked in the handler).
    pub payout_mint: UncheckedAccount<'info>,
    /// CHECK: ATA(auth, payout_mint, payout_token_program).
    #[account(mut, address = ata(&auth.key(), &payout_mint.key(), &payout_token_program.key()) @ VaultError::WrongAccount)]
    pub auth_payout: UncheckedAccount<'info>,
    /// CHECK: ATA(wallet, payout_mint, payout_token_program), created here if needed.
    #[account(mut, address = ata(&wallet.key(), &payout_mint.key(), &payout_token_program.key()) @ VaultError::WrongAccount)]
    pub wallet_payout: UncheckedAccount<'info>,
    /// The payout mint's token program (SPL Token or Token-2022).
    pub payout_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ---------- Events ----------

#[event]
pub struct Collected {
    pub vault: Pubkey,
    pub got: u64,
    pub burned: u64,
}

#[event]
pub struct Sold {
    pub vault: Pubkey,
    pub tokens_in: u64,
    pub xnt_out: u64,
    pub to_lp: u64,
    pub to_creator: u64,
    pub to_holders: u64,
    pub crank_reward: u64,
}

#[event]
pub struct LiquidityAdded {
    pub vault: Pubkey,
    pub tokens: u64,
    pub xnt: u64,
    pub lp_burned: u64,
}

#[event]
pub struct CreatorFunded {
    pub vault: Pubkey,
    /// XNT swapped.
    pub xnt_in: u64,
    /// Reward tokens deposited into the lock NFT's reward vault.
    pub reward_out: u64,
    pub reward_mint: Pubkey,
}

#[event]
pub struct HoldersFunded {
    pub vault: Pubkey,
    /// Holders' XNT swapped.
    pub xnt_in: u64,
    /// Payout tokens added to the holder pool.
    pub payout_out: u64,
    pub payout_mint: Pubkey,
}

#[event]
pub struct ListPublished {
    pub vault: Pubkey,
    pub epoch: u64,
    pub root: [u8; 32],
    pub total: u64,
    pub active_at: i64,
}

#[event]
pub struct ListCancelled {
    pub vault: Pubkey,
    pub epoch: u64,
}

#[event]
pub struct Paid {
    pub vault: Pubkey,
    pub wallet: Pubkey,
    pub amount: u64,
    pub cumulative: u64,
}

#[event]
pub struct PublisherChanged {
    pub vault: Pubkey,
    pub old: Pubkey,
    pub new: Pubkey,
    /// true = appointed by the guardian, false = rotated by the publisher.
    pub by_guardian: bool,
}

#[event]
pub struct FallbackPaid {
    pub vault: Pubkey,
    pub wallet: Pubkey,
    pub amount: u64,
    /// floor(cumulative * holders_funded / list_total): the wallet's total paid after this.
    pub entitled: u64,
}

#[error_code]
pub enum VaultError {
    #[msg("Mint must be a Token-2022 tax token with only transfer-fee/metadata extensions, no freeze authority and a 0.01-99.99% fee")]
    BadMint,
    #[msg("Fee config authority must be None, the withdraw authority must be the vault's auth, and the creator (or an atomic hand-over) must create the vault")]
    BadAuthority,
    #[msg("Pool must be this mint's XDEX TOKEN/wXNT pool")]
    BadPool,
    #[msg("Lock must be the lp_locker lock of this NFT for this pool")]
    BadLock,
    #[msg("Split must be burn <= 50%, LP <= 50%, burn + LP <= 55%")]
    BadSplit,
    #[msg("Signer is not the vault's publisher")]
    NotPublisher,
    #[msg("Signer is not the vault's guardian")]
    NotGuardian,
    #[msg("List epoch must increase")]
    StaleEpoch,
    #[msg("List total can't go down")]
    TotalDecreased,
    #[msg("List total is more than the holders' share has received")]
    OverFunded,
    #[msg("No pending list")]
    NoPendingList,
    #[msg("Merkle proof doesn't match the active list")]
    BadProof,
    #[msg("No tax to collect")]
    NothingToCollect,
    #[msg("Nothing owed to this wallet")]
    NothingToPay,
    #[msg("Amount too small")]
    TooSmall,
    #[msg("The vault would not cover what it owes")]
    Insolvent,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Wrong account")]
    WrongAccount,
    #[msg("Only one sale per slot")]
    OneSellPerSlot,
    #[msg("Wrong vault version (run upgrade_vault on a v1/v2 vault; it can't run twice)")]
    WrongVersion,
    #[msg("The guardian can't cancel more lists in a row until one goes live")]
    TooManyCancels,
    #[msg("Reward mint must be the vault's reward token, without a transfer fee")]
    BadRewardMint,
    #[msg("The publisher has published recently; the guardian can't appoint a new one yet")]
    PublisherActive,
    #[msg("Fallback payments start only after a long time without a published list")]
    FallbackNotActive,
    #[msg("This vault pays holders in its payout token: use pay_token / pay_fallback_token")]
    PaysInToken,
    #[msg("This vault pays holders in XNT")]
    PaysInXnt,
    #[msg("Payout token must have no freeze authority and no transfer fee, hook, delegate or pause, and differ from the tax token and XNT")]
    BadPayoutMint,
    #[msg("Payout pool must be the payout token's XDEX pool against wXNT, with swaps open")]
    BadPayoutPool,
}

#[cfg(test)]
mod tests {
    use super::math::*;
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn tree(leaves: &[[u8; 32]], idx: usize) -> ([u8; 32], Vec<[u8; 32]>) {
        let mut level = leaves.to_vec();
        let (mut i, mut proof) = (idx, vec![]);
        while level.len() > 1 {
            let mut next = vec![];
            for pair in level.chunks(2) {
                next.push(if pair.len() == 1 {
                    pair[0]
                } else {
                    let (a, b) = if pair[0] <= pair[1] { (pair[0], pair[1]) } else { (pair[1], pair[0]) };
                    hashv(&[&a, &b]).to_bytes()
                });
            }
            if i ^ 1 < level.len() {
                proof.push(level[i ^ 1]);
            }
            i /= 2;
            level = next;
        }
        (level[0], proof)
    }

    #[test]
    fn creator_deposit_keeps_the_holders_tokens() {
        // Separate reward account (keep 0): the swap output and any stray tokens go to the creator.
        assert_eq!(creator_deposit(0, 500, 0).unwrap(), 500);
        assert_eq!(creator_deposit(7, 507, 0).unwrap(), 507);
        // Shared with the holders' payout account: 1_000 owed stays, the swap output (and strays above it) goes.
        assert_eq!(creator_deposit(1_000, 1_500, 1_000).unwrap(), 500);
        assert_eq!(creator_deposit(1_020, 1_520, 1_000).unwrap(), 520);
        // The account can't already be short of what the holders are owed.
        assert!(creator_deposit(900, 1_400, 1_000).is_err());
        assert!(creator_deposit(1_000, 999, 0).is_err());
    }

    #[test]
    fn merkle_test_vector() {
        // vault = [1; 32], wallet A = [2; 32] cumulative 1_000_000_000, wallet B = [3; 32] cumulative 5.
        let vault = Pubkey::new_from_array([1; 32]);
        let a = vault_leaf(&vault, &Pubkey::new_from_array([2; 32]), 1_000_000_000);
        let b = vault_leaf(&vault, &Pubkey::new_from_array([3; 32]), 5);
        let (root, proof) = tree(&[a, b], 0);
        println!("leaf A = {}", hex(&a));
        println!("leaf B = {}", hex(&b));
        println!("root(A,B) = {}", hex(&root));
        assert_eq!(proof, vec![b]);
        assert!(verify_proof(&proof, &root, a));
        assert!(verify_proof(&[a], &root, b));
        assert_eq!(hex(&a), "f1df94e69dc2ad0365865c9eaeb81deac6bfbc98a2e5abe33decf1128b63e821");
        assert_eq!(hex(&root), "1992f5473e12ba77f8b909f1cb3272b5492544fc3e37ea7a5d7c3776290bda6a");
    }

    #[test]
    fn proofs_verify_and_reject_tampering() {
        let vault = Pubkey::new_unique();
        let wallets: Vec<Pubkey> = (0..9).map(|_| Pubkey::new_unique()).collect();
        let leaves: Vec<[u8; 32]> = wallets.iter().enumerate().map(|(i, w)| vault_leaf(&vault, w, 1_000 * (i as u64 + 1))).collect();
        for idx in 0..leaves.len() {
            let (root, proof) = tree(&leaves, idx);
            assert!(verify_proof(&proof, &root, leaves[idx]));
            assert!(!verify_proof(&proof, &root, vault_leaf(&vault, &wallets[idx], 1_000 * (idx as u64 + 1) + 1)));
            assert!(!verify_proof(&proof, &root, vault_leaf(&Pubkey::new_unique(), &wallets[idx], 1_000 * (idx as u64 + 1))));
            assert!(!verify_proof(&proof, &root, vault_leaf(&vault, &Pubkey::new_unique(), 1_000 * (idx as u64 + 1))));
        }
        let (root, proof) = tree(&leaves[..1], 0);
        assert!(proof.is_empty() && verify_proof(&proof, &root, leaves[0]));
    }

    #[test]
    fn split_sums_and_limits() {
        assert!(check_split(5000, 500).is_ok());
        assert!(check_split(2500, 2500).is_ok());
        assert!(check_split(5001, 0).is_err());
        assert!(check_split(0, 5001).is_err());
        assert!(check_split(3000, 2501).is_err());
        let mut seed = 7u64;
        let mut rnd = || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed };
        for _ in 0..20_000 {
            let got = rnd() % 1_000_000_000_000_000 + 1;
            let burn = (rnd() % 5001) as u16;
            let lp = ((rnd() % 5001) as u16).min(MAX_BURN_PLUS_LP_BPS - burn);
            let s = split(got, burn, lp, CREATOR_BPS).unwrap();
            assert_eq!(s.burn + s.lp + s.creator + s.holders, got);
            assert!(s.burn as u128 * BPS as u128 <= got as u128 * burn as u128);
            // Holders keep at least 35% (rounding only adds to them).
            assert!(s.holders as u128 * BPS as u128 >= got as u128 * 3500);
        }
        let s = split(u64::MAX, 5000, 500, 1000).unwrap();
        assert_eq!(s.burn + s.lp + s.creator + s.holders, u64::MAX);
        let s = split(1, 2500, 2500, 1000).unwrap();
        assert_eq!((s.burn, s.lp, s.creator, s.holders), (0, 0, 0, 1));
    }

    #[test]
    fn take_is_pro_rata_and_bounded() {
        let mut seed = 99u64;
        let mut rnd = || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed };
        for i in 0..50_000 {
            let small = i % 3 == 0;
            let m = if small { 5 } else { 1_000_000_000_000 };
            let (lp, cr, ho) = (rnd() % m, rnd() % m, rnd() % m);
            let total = lp + cr + ho;
            if total == 0 { continue; }
            let amount = rnd() % total + 1;
            let t = take(amount, lp, cr, ho).unwrap();
            assert_eq!(t.lp + t.creator + t.holders, amount);
            assert!(t.lp <= lp && t.creator <= cr && t.holders <= ho);
            if amount == total { assert_eq!((t.lp, t.creator, t.holders), (lp, cr, ho)); }
            let out = rnd() % 100_000_000_000;
            let p = proceeds(out, amount, &t).unwrap();
            assert_eq!(p.lp + p.creator + p.holders, out);
            assert!(p.lp as u128 * amount as u128 <= out as u128 * t.lp as u128);
            assert!(p.creator as u128 * amount as u128 <= out as u128 * t.creator as u128);
            assert!(p.reward <= CRANK_REWARD_CAP && p.reward <= p.holders);
            assert!(p.reward as u128 * BPS as u128 <= p.holders as u128 * CRANK_REWARD_BPS as u128);
        }
        // Tiny buckets: the rounding rest can't overdraw holders.
        let t = take(1, 1, 1, 0).unwrap();
        assert_eq!(t.holders, 0);
        assert_eq!(t.lp + t.creator, 1);
        assert!(take(0, 1, 1, 1).is_err());
        assert!(take(4, 1, 1, 1).is_err());
        // The reward caps at 0.05 XNT.
        let p = proceeds(100_000_000_000, 10, &Take { lp: 0, creator: 0, holders: 10 }).unwrap();
        assert_eq!(p.reward, CRANK_REWARD_CAP);
    }

    #[test]
    fn impact_cap_and_expected_out() {
        assert_eq!(impact_bps(500), 250);
        assert_eq!(impact_bps(1000), 300);
        assert_eq!(impact_bps(100), 50);
        assert_eq!(impact_bps(1), 0);
        let reserve = 1_000_000_000_000_000u64;
        for (tax, max_fee) in [(500u64, u64::MAX), (100, u64::MAX), (1000, 1_000_000)] {
            let impact = impact_bps(tax);
            let gross = max_input_for_impact(reserve, impact, tax, max_fee).unwrap();
            let fee = ((gross as u128 * tax as u128).div_ceil(BPS as u128) as u64).min(max_fee);
            let net = gross - fee;
            // net / (reserve + net) <= impact
            assert!(net as u128 * BPS as u128 <= impact as u128 * (reserve as u128 + net as u128));
        }
        assert_eq!(max_input_for_impact(reserve, 0, 500, u64::MAX).unwrap(), 0);
        // CPMM output never exceeds the no-fee constant-product output, and k never drops.
        let (rin, rout) = (5_000_000_000_000_000u64, 20_000_000_000u64);
        for net in [1u64, 1_000, 1_000_000_000, 100_000_000_000_000] {
            let out = cpmm_out(net, rin, rout, 3_000).unwrap();
            assert!(out as u128 * (rin as u128 + net as u128) <= net as u128 * rout as u128);
            assert!((rin as u128 + net as u128) * (rout - out) as u128 >= rin as u128 * rout as u128);
        }
        assert_eq!(min_out(1_000_000).unwrap(), 995_000);
    }

    #[test]
    fn deposit_fits_budgets() {
        let fee = |bps: u64| move |net: u64| -> Option<u64> {
            if net == 0 { return Some(0); }
            let pre = (net as u128 * BPS as u128).div_ceil((BPS - bps) as u128);
            Some(((pre * bps as u128).div_ceil(BPS as u128)) as u64)
        };
        let mut seed = 3u64;
        let mut rnd = || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed };
        for _ in 0..5_000 {
            let rt = rnd() % 1_000_000_000_000_000_000 + 1_000_000;
            let rx = rnd() % 100_000_000_000_000 + 1_000_000;
            let supply = rnd() % 10_000_000_000_000 + 1_000;
            let tokens = rnd() % (rt / 10 + 1);
            let xnt = rnd() % (rx / 10 + 1);
            if let Some(d) = deposit_for(tokens, xnt, rt, rx, supply, fee(500)).unwrap() {
                assert!(d.tokens <= tokens && d.xnt <= xnt && d.lp > 0);
                let (nt, nx) = deposit_amounts(d.lp, rt, rx, supply).unwrap();
                assert_eq!(nx, d.xnt);
                assert!(nt < d.tokens);
                // Near-maximal: 0.1% more LP no longer fits.
                let more = d.lp + d.lp / 1000 + 1;
                let (mt, mx) = deposit_amounts(more, rt, rx, supply).unwrap();
                assert!(mt + fee(500)(mt).unwrap() > tokens || mx > xnt, "lp {} not near-maximal", d.lp);
            }
        }
        // Enough on both sides: most of the binding side is used.
        let d = deposit_for(1_000_000_000_000, 10_000_000_000, 1_000_000_000_000_000, 10_000_000_000_000, 100_000_000_000, fee(500))
            .unwrap()
            .unwrap();
        assert!(d.xnt * 1000 >= 10_000_000_000 * 940 || d.tokens * 1000 >= 1_000_000_000_000 * 990);
        assert!(deposit_for(0, 1, 1, 1, 1, fee(500)).unwrap().is_none());
    }

    #[test]
    fn list_rules() {
        // First list.
        assert!(check_publish(0, 0, 0, 0, 100, 0, 1, 100).is_ok());
        assert!(check_publish(0, 0, 0, 0, 100, 0, 0, 1).is_err()); // epoch must be > 0
        // Epoch must beat both the active and the pending list.
        assert!(check_publish(3, 0, 50, 0, 100, 0, 3, 60).is_err());
        assert!(check_publish(3, 5, 50, 60, 100, 0, 5, 60).is_err());
        assert!(check_publish(3, 5, 50, 60, 100, 0, 6, 60).is_ok());
        // Total never decreases (vs active and pending) and never exceeds holders_funded.
        assert!(check_publish(3, 0, 50, 0, 100, 0, 4, 49).is_err());
        assert!(check_publish(3, 5, 50, 60, 100, 0, 6, 59).is_err());
        assert!(check_publish(3, 0, 50, 0, 100, 0, 4, 101).is_err());
        assert!(check_publish(3, 0, 50, 0, 100, 0, 4, 100).is_ok());
        let e = check_publish(3, 0, 50, 0, 100, 0, 4, 101).unwrap_err();
        assert_eq!(e, error!(VaultError::OverFunded));
        assert_eq!(check_publish(3, 0, 50, 0, 100, 0, 2, 60).unwrap_err(), error!(VaultError::StaleEpoch));
        assert_eq!(check_publish(3, 0, 50, 0, 100, 0, 4, 40).unwrap_err(), error!(VaultError::TotalDecreased));
        // v3: the total also covers what was already paid (fallback can pay past list_total).
        assert!(check_publish(3, 0, 50, 0, 100, 70, 4, 70).is_ok());
        assert_eq!(check_publish(3, 0, 50, 0, 100, 70, 4, 69).unwrap_err(), error!(VaultError::TotalDecreased));
        assert_eq!(check_publish(3, 0, 50, 0, 100, 101, 4, 100).unwrap_err(), error!(VaultError::TotalDecreased));
        assert!(check_publish(3, 5, 50, 60, 100, 55, 6, 60).is_ok());
        assert_eq!(check_publish(3, 5, 50, 60, 100, 61, 6, 60).unwrap_err(), error!(VaultError::TotalDecreased));
    }

    fn blank() -> Vault {
        Vault {
            mint: Pubkey::default(), pool: Pubkey::default(), creator_nft: Pubkey::default(), reward_mint: Pubkey::default(),
            reward_swap_pool: Pubkey::default(), publisher: Pubkey::default(), guardian: Pubkey::default(), burn_bps: 0,
            lp_bps: 0, creator_bps: 1000, pending_tokens: 0, lp_tokens: 0, sell_lp: 0, sell_creator: 0, sell_holders: 0,
            xnt_lp: 0, xnt_creator: 0, holders_funded: 0, holders_paid: 0, list_epoch: 0, list_root: [0; 32], list_total: 0,
            pending_epoch: 0, pending_root: [0; 32], pending_total: 0, pending_active_at: 0, total_collected: 0,
            total_burned: 0, total_lp_tokens: 0, total_lp_xnt: 0, total_creator_xnt: 0, total_crank_rewards: 0,
            created_at: 0, bump: 0, auth_bump: 0, last_sell_slot: 0, version: VAULT_VERSION, cancels_in_row: 0,
            total_reward_out: 0, last_reward_slot: 0, last_publish_at: 0, list_cid: [0; 33], pending_cid: [0; 33],
            fallback_paid: 0, payout_pool: Pubkey::default(), xnt_holders: 0, reserved: [0; 20],
        }
    }

    #[test]
    fn pending_list_activates_only_when_due() {
        let mut v = blank();
        v.pending_epoch = 2;
        v.pending_root = [9; 32];
        v.pending_total = 77;
        v.pending_active_at = 1_000;
        activate_if_due(&mut v, 999);
        assert_eq!((v.list_epoch, v.pending_epoch), (0, 2));
        activate_if_due(&mut v, 1_000);
        assert_eq!((v.list_epoch, v.list_root, v.list_total, v.pending_epoch), (2, [9; 32], 77, 0));
        v.xnt_lp = 5;
        v.xnt_creator = 6;
        v.holders_funded = 100;
        v.holders_paid = 30;
        assert_eq!(promised(&v).unwrap(), 81);
        v.holders_paid = 101;
        assert!(promised(&v).is_err());
    }

    #[test]
    fn vault_size() {
        assert_eq!(8 + Vault::INIT_SPACE, VAULT_V3_LEN);
        assert_eq!((VAULT_V1_LEN, VAULT_V2_LEN, VAULT_V3_LEN), (480, 552, 640));
        assert_eq!(8 + PaidRecord::INIT_SPACE, 81);
        assert_eq!(&hashv(&[b"account:Vault"]).to_bytes()[..8], &VAULT_DISC);
        assert_eq!(Vault::DISCRIMINATOR, &VAULT_DISC);
    }

    /// A vault whose every field has a distinct, recognisable value.
    fn filled() -> Vault {
        let k = |b: u8| Pubkey::new_from_array([b; 32]);
        Vault {
            mint: k(1), pool: k(2), creator_nft: k(3), reward_mint: k(4), reward_swap_pool: k(5), publisher: k(6),
            guardian: k(7), burn_bps: 0x0908, lp_bps: 0x0b0a, creator_bps: 0x0d0c, pending_tokens: 0x11, lp_tokens: 0x12,
            sell_lp: 0x13, sell_creator: 0x14, sell_holders: 0x15, xnt_lp: 0x16, xnt_creator: 0x17, holders_funded: 0x18,
            holders_paid: 0x19, list_epoch: 0x1a, list_root: [0x1b; 32], list_total: 0x1c, pending_epoch: 0x1d,
            pending_root: [0x1e; 32], pending_total: 0x1f, pending_active_at: 0x20, total_collected: 0x21,
            total_burned: 0x22, total_lp_tokens: 0x23, total_lp_xnt: 0x24, total_creator_xnt: 0x25,
            total_crank_rewards: 0x26, created_at: 0x27, bump: 0x28, auth_bump: 0x29, last_sell_slot: 0x2a,
            version: VAULT_VERSION, cancels_in_row: 0x2b, total_reward_out: 0x2c, last_reward_slot: 0x2d,
            last_publish_at: 0x2f, list_cid: [0x30; 33], pending_cid: [0x31; 33], fallback_paid: 0x32, payout_pool: Pubkey::new_from_array([0x2e; 32]), xnt_holders: 0x2e2e2e2e2e2e2e2e, reserved: [0x2e; 20],
        }
    }

    #[test]
    fn layout_offsets_match_the_spec() {
        let mut buf = Vec::new();
        filled().try_serialize(&mut buf).unwrap();
        assert_eq!(buf.len(), VAULT_V3_LEN);
        assert_eq!(&buf[..8], &VAULT_DISC);
        let key_at = |o: usize, b: u8| assert_eq!(&buf[o..o + 32], &[b; 32], "pubkey at {o}");
        let u64_at = |o: usize, v: u64| assert_eq!(u64::from_le_bytes(buf[o..o + 8].try_into().unwrap()), v, "u64 at {o}");
        for (o, b) in [(8, 1), (40, 2), (72, 3), (104, 4), (136, 5), (168, 6), (200, 7)] {
            key_at(o, b);
        }
        assert_eq!(u16::from_le_bytes([buf[232], buf[233]]), 0x0908);
        assert_eq!(u16::from_le_bytes([buf[234], buf[235]]), 0x0b0a);
        assert_eq!(u16::from_le_bytes([buf[236], buf[237]]), 0x0d0c);
        for (o, v) in [(238, 0x11), (246, 0x12), (254, 0x13), (262, 0x14), (270, 0x15), (278, 0x16), (286, 0x17), (294, 0x18),
            (302, 0x19), (310, 0x1a), (350, 0x1c), (358, 0x1d), (398, 0x1f), (406, 0x20), (414, 0x21), (422, 0x22),
            (430, 0x23), (438, 0x24), (446, 0x25), (454, 0x26), (462, 0x27), (472, 0x2a), (482, 0x2c), (490, 0x2d),
            (498, 0x2f), (572, 0x32)] {
            u64_at(o, v);
        }
        assert_eq!(&buf[318..350], &[0x1b; 32]);
        assert_eq!(&buf[366..398], &[0x1e; 32]);
        assert_eq!((buf[470], buf[471]), (0x28, 0x29));
        assert_eq!((buf[480], buf[481]), (VAULT_VERSION, 0x2b));
        assert_eq!(&buf[506..539], &[0x30; 33]);
        assert_eq!(&buf[539..572], &[0x31; 33]);
        assert_eq!(&buf[580..640], &[0x2e; 60]);
    }

    /// The raw bytes of `filled()` as an older layout: v2 = its first 498 bytes (version 2)
    /// followed by 54 reserved bytes; v1 = its first 480 bytes.
    fn old_vault(len: usize) -> Vec<u8> {
        let mut d = Vec::new();
        filled().try_serialize(&mut d).unwrap();
        d.truncate(len);
        if len == VAULT_V2_LEN {
            d[480] = 2;
            d[498..].fill(0x77);
        }
        d
    }

    #[test]
    fn upgrade_v1_to_v3_keeps_v1_bytes() {
        let v1 = old_vault(VAULT_V1_LEN);
        // A 480-byte v1 vault is refused by the v3 deserializer.
        assert_eq!(Vault::try_deserialize(&mut &v1[..]).err().unwrap(), error!(VaultError::WrongVersion));
        let mut d = v1.clone();
        // After the realloc the new bytes are whatever the runtime gave.
        d.resize(VAULT_V3_LEN, 0xff);
        upgrade_layout(&mut d, VAULT_V1_LEN, 1_234_567).unwrap();
        // Untouched: everything but reward_mint / reward_swap_pool.
        assert_eq!(&d[..REWARD_MINT_OFFSET], &v1[..REWARD_MINT_OFFSET]);
        assert_eq!(&d[168..VAULT_V1_LEN], &v1[168..VAULT_V1_LEN]);
        assert_eq!(&d[104..136], REWARD_MINT.as_ref());
        assert_eq!(&d[136..168], REWARD_POOL.as_ref());
        assert_eq!(d[480], 3);
        assert!(d[481..498].iter().all(|&b| b == 0));
        assert_eq!(i64::from_le_bytes(d[498..506].try_into().unwrap()), 1_234_567);
        assert!(d[506..].iter().all(|&b| b == 0));
        let v = Vault::try_deserialize(&mut &d[..]).unwrap();
        let f = filled();
        assert_eq!((v.mint, v.pool, v.creator_nft, v.publisher, v.guardian), (f.mint, f.pool, f.creator_nft, f.publisher, f.guardian));
        assert_eq!((v.reward_mint, v.reward_swap_pool), (REWARD_MINT, REWARD_POOL));
        assert_eq!((v.xnt_creator, v.holders_funded, v.list_root, v.last_sell_slot, v.bump, v.auth_bump), (0x17, 0x18, [0x1b; 32], 0x2a, 0x28, 0x29));
        assert_eq!((v.version, v.cancels_in_row, v.total_reward_out, v.last_reward_slot), (3, 0, 0, 0));
        assert_eq!((v.last_publish_at, v.list_cid, v.pending_cid, v.fallback_paid, v.payout_pool, v.xnt_holders, v.reserved), (1_234_567, [0; 33], [0; 33], 0, Pubkey::default(), 0, [0; 20]));
        // Upgrading needs exactly a 640-byte buffer with the vault discriminator.
        assert!(upgrade_layout(&mut v1.clone(), VAULT_V1_LEN, 0).is_err());
        let mut other = v1.clone();
        other.resize(VAULT_V3_LEN, 0);
        other[0] ^= 1;
        assert!(upgrade_layout(&mut other, VAULT_V1_LEN, 0).is_err());
        let mut odd = v1.clone();
        odd.resize(VAULT_V3_LEN, 0);
        assert_eq!(upgrade_layout(&mut odd, 500, 0).unwrap_err(), error!(VaultError::WrongVersion));
        assert_eq!(upgrade_layout(&mut odd, VAULT_V3_LEN, 0).unwrap_err(), error!(VaultError::WrongVersion));
    }

    #[test]
    fn upgrade_v2_to_v3_keeps_v2_fields() {
        let v2 = old_vault(VAULT_V2_LEN);
        assert_eq!(Vault::try_deserialize(&mut &v2[..]).err().unwrap(), error!(VaultError::WrongVersion));
        let mut d = v2.clone();
        d.resize(VAULT_V3_LEN, 0xff);
        upgrade_layout(&mut d, VAULT_V2_LEN, -5).unwrap();
        // Every v1 and v2 byte kept (reward mint/pool too), except the version byte.
        assert_eq!(&d[..480], &v2[..480]);
        assert_eq!(&d[481..498], &v2[481..498]);
        assert_eq!(d[480], 3);
        assert_eq!(i64::from_le_bytes(d[498..506].try_into().unwrap()), -5);
        assert!(d[506..].iter().all(|&b| b == 0));
        let v = Vault::try_deserialize(&mut &d[..]).unwrap();
        let f = filled();
        assert_eq!((v.reward_mint, v.reward_swap_pool), (f.reward_mint, f.reward_swap_pool));
        assert_eq!((v.cancels_in_row, v.total_reward_out, v.last_reward_slot), (0x2b, 0x2c, 0x2d));
        assert_eq!((v.pending_epoch, v.pending_root, v.pending_total, v.pending_active_at), (0x1d, [0x1e; 32], 0x1f, 0x20));
        assert_eq!((v.version, v.last_publish_at, v.list_cid, v.pending_cid, v.fallback_paid, v.payout_pool, v.xnt_holders, v.reserved), (3, -5, [0; 33], [0; 33], 0, Pubkey::default(), 0, [0; 20]));
        // A 552-byte account whose version byte isn't 2 is refused.
        let mut bad = v2.clone();
        bad[480] = 3;
        bad.resize(VAULT_V3_LEN, 0);
        assert_eq!(upgrade_layout(&mut bad, VAULT_V2_LEN, 0).unwrap_err(), error!(VaultError::WrongVersion));
        // Any other version byte on a 640-byte account is refused by the deserializer.
        let mut v4 = d.clone();
        v4[480] = 2;
        assert_eq!(Vault::try_deserialize(&mut &v4[..]).err().unwrap(), error!(VaultError::WrongVersion));
        v4[480] = 4;
        assert_eq!(Vault::try_deserialize(&mut &v4[..]).err().unwrap(), error!(VaultError::WrongVersion));
    }

    #[test]
    fn cids_follow_the_list() {
        let mut v = blank();
        v.pending_epoch = 2;
        v.pending_cid = [0x55; 33];
        v.pending_active_at = 10;
        activate_if_due(&mut v, 9);
        assert_eq!((v.list_cid, v.pending_cid), ([0; 33], [0x55; 33]));
        activate_if_due(&mut v, 10);
        assert_eq!((v.list_cid, v.pending_cid), ([0x55; 33], [0; 33]));
    }

    #[test]
    fn appoint_and_fallback_timing() {
        let t0 = 1_700_000_000i64;
        assert_eq!(check_appoint(t0, t0 + APPOINT_AFTER_SECS - 1).unwrap_err(), error!(VaultError::PublisherActive));
        assert!(check_appoint(t0, t0 + APPOINT_AFTER_SECS).is_ok());
        assert!(check_appoint(t0, t0 + FALLBACK_AFTER_SECS).is_ok());
        assert_eq!(check_appoint(t0, t0).unwrap_err(), error!(VaultError::PublisherActive));
        // No overflow at the edge of i64.
        assert_eq!(check_appoint(i64::MAX, i64::MAX - 1).unwrap_err(), error!(VaultError::PublisherActive));
        let e = error!(VaultError::FallbackNotActive);
        assert_eq!(check_fallback(1, 0, t0, t0 + FALLBACK_AFTER_SECS - 1).unwrap_err(), e);
        assert!(check_fallback(1, 0, t0, t0 + FALLBACK_AFTER_SECS).is_ok());
        // No active list, or a list pending: no fallback.
        assert_eq!(check_fallback(0, 0, t0, t0 + FALLBACK_AFTER_SECS).unwrap_err(), e);
        assert_eq!(check_fallback(1, 2, t0, t0 + FALLBACK_AFTER_SECS).unwrap_err(), e);
        #[cfg(not(feature = "short-windows"))]
        assert_eq!((APPOINT_AFTER_SECS, FALLBACK_AFTER_SECS), (7 * 86_400, 30 * 86_400));
        assert!(APPOINT_AFTER_SECS < FALLBACK_AFTER_SECS);
    }

    #[test]
    fn fallback_entitlement() {
        // Scaled up by funded / list_total, rounded down.
        let f = fallback_pay(300, 1_000, 900, 0, 0).unwrap();
        assert_eq!(f, Fallback { entitled: 333, amount: 333 });
        let f = fallback_pay(300, 1_000, 900, 300, 900).unwrap();
        assert_eq!(f, Fallback { entitled: 333, amount: 33 });
        assert_eq!(fallback_pay(300, 1_000, 900, 333, 0).unwrap_err(), error!(VaultError::NothingToPay));
        assert_eq!(fallback_pay(300, 1_000, 900, 400, 0).unwrap_err(), error!(VaultError::NothingToPay));
        // Nothing funded beyond the list: entitled == cumulative.
        assert_eq!(fallback_pay(300, 900, 900, 0, 0).unwrap().entitled, 300);
        // u128 maths: no overflow near u64::MAX.
        let big = u64::MAX / 2;
        let f = fallback_pay(big, u64::MAX, u64::MAX, 0, 0).unwrap();
        assert_eq!(f.entitled, big);
        let f = fallback_pay(u64::MAX / 3, u64::MAX, u64::MAX / 2, 0, 0).unwrap();
        assert_eq!(f.entitled as u128, (u64::MAX / 3) as u128 * u64::MAX as u128 / (u64::MAX / 2) as u128);
        // A leaf above the list total would be entitled to more than was funded: capped.
        assert_eq!(fallback_pay(1_000, 1_000, 500, 0, 0).unwrap_err(), error!(VaultError::OverFunded));
        assert_eq!(fallback_pay(u64::MAX, u64::MAX, 1, 0, 0).unwrap_err(), error!(VaultError::MathOverflow));
        // Payments in all never exceed holders_funded.
        assert_eq!(fallback_pay(300, 1_000, 900, 0, 700).unwrap_err(), error!(VaultError::OverFunded));
        assert_eq!(fallback_pay(300, 1_000, 900, 0, 667).unwrap().amount, 333);
        // A zero-total list pays nothing.
        assert_eq!(fallback_pay(5, 1_000, 0, 0, 0).unwrap_err(), error!(VaultError::NothingToPay));
        // Random lists: paying every wallet never exceeds funded, and each gets its floor.
        let mut seed = 5u64;
        let mut rnd = || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed };
        for _ in 0..2_000 {
            let n = (rnd() % 20 + 1) as usize;
            let c: Vec<u64> = (0..n).map(|_| rnd() % 1_000_000_000_000).collect();
            let total: u64 = c.iter().sum();
            if total == 0 { continue; }
            let funded = total + rnd() % (total * 3 + 1);
            // Each wallet was already paid part of its cumulative by the normal path.
            let paid: Vec<u64> = c.iter().map(|&x| if x == 0 { 0 } else { rnd() % (x + 1) }).collect();
            let mut holders_paid: u64 = paid.iter().sum();
            for i in 0..n {
                let want = (c[i] as u128 * funded as u128 / total as u128) as u64;
                match fallback_pay(c[i], funded, total, paid[i], holders_paid) {
                    Ok(f) => {
                        assert_eq!(f.entitled, want);
                        assert_eq!(f.amount, want - paid[i]);
                        holders_paid += f.amount;
                    }
                    Err(e) => {
                        assert_eq!(e, error!(VaultError::NothingToPay));
                        assert!(want <= paid[i]);
                    }
                }
                assert!(holders_paid <= funded);
            }
            // Rounding leaves less than one lamport per wallet unpaid.
            assert!(funded - holders_paid < n as u64 || funded == holders_paid);
        }
    }

    #[test]
    fn cancel_counter_rules() {
        assert_eq!(MAX_CANCELS_IN_ROW, 2);
        assert_eq!(next_cancel(0).unwrap(), 1);
        assert_eq!(next_cancel(1).unwrap(), 2);
        assert_eq!(next_cancel(2).unwrap_err(), error!(VaultError::TooManyCancels));
        assert_eq!(next_cancel(u8::MAX).unwrap_err(), error!(VaultError::TooManyCancels));
        // A list going live resets it; a list that isn't due yet doesn't.
        let mut v = blank();
        v.cancels_in_row = 2;
        v.pending_epoch = 5;
        v.pending_active_at = 100;
        activate_if_due(&mut v, 99);
        assert_eq!(v.cancels_in_row, 2);
        activate_if_due(&mut v, 100);
        assert_eq!((v.cancels_in_row, v.list_epoch), (0, 5));
        // Nothing pending: no reset either (only a list going live counts).
        v.cancels_in_row = 1;
        activate_if_due(&mut v, 1_000);
        assert_eq!(v.cancels_in_row, 1);
    }

    #[test]
    fn reward_swap_cap() {
        // Half the trade fee (3000 millionths = 0.30% -> 15 bps), never above 300 bps.
        assert_eq!(reward_impact_bps(3000), 15);
        assert_eq!(reward_impact_bps(2800), 14);
        assert_eq!(reward_impact_bps(100_000), 300);
        assert_eq!(reward_impact_bps(199), 0);
        let reserve = 34_369_347_033_187u64; // the testnet XNM pool's XNT side
        let cap = reward_swap_in(u64::MAX, reserve, 3000).unwrap();
        assert_eq!(cap, (reserve as u128 * 15 / 9985) as u64);
        // The capped swap's impact (after / (reserve + after)) stays at or under 15 bps.
        assert!(cap as u128 * BPS as u128 <= 15 * (reserve as u128 + cap as u128));
        assert!((cap + 2) as u128 * BPS as u128 > 15 * (reserve as u128 + cap as u128 + 2));
        // Under the cap everything goes; zero stays zero.
        assert_eq!(reward_swap_in(1_000_000_000, reserve, 3000).unwrap(), 1_000_000_000);
        assert_eq!(reward_swap_in(0, reserve, 3000).unwrap(), 0);
        assert_eq!(reward_swap_in(5, reserve, 100).unwrap(), 0);
        // Expected output and min out as the handler computes them.
        let xnm = 3_358_454_947_163_493u64;
        let out = cpmm_out(cap, reserve, xnm, 3000).unwrap();
        assert!(out as u128 * (reserve as u128 + cap as u128) <= cap as u128 * xnm as u128);
        assert!(min_out(out).unwrap() < out);
    }

    #[test]
    fn reward_mint_extensions() {
        use anchor_spl::token_2022::spl_token_2022::extension::{
            metadata_pointer::MetadataPointer, transfer_fee::TransferFeeConfig, BaseStateWithExtensionsMut, StateWithExtensionsMut,
        };
        use anchor_lang::solana_program::program_pack::Pack;
        fn mint_with(exts: &[ExtensionType]) -> Vec<u8> {
            let len = ExtensionType::try_calculate_account_len::<MintState>(exts).unwrap();
            let mut d = vec![0u8; len];
            let mut st = StateWithExtensionsMut::<MintState>::unpack_uninitialized(&mut d).unwrap();
            for e in exts {
                match e {
                    ExtensionType::TransferFeeConfig => {
                        st.init_extension::<TransferFeeConfig>(true).unwrap();
                    }
                    ExtensionType::MetadataPointer => {
                        st.init_extension::<MetadataPointer>(true).unwrap();
                    }
                    _ => unreachable!(),
                }
            }
            st.base = MintState { decimals: 9, is_initialized: true, supply: 1, ..Default::default() };
            st.pack_base();
            st.init_account_type().unwrap();
            d
        }
        assert!(reward_mint_ok(&mint_with(&[ExtensionType::MetadataPointer])).is_ok());
        assert_eq!(reward_mint_ok(&mint_with(&[ExtensionType::TransferFeeConfig])).unwrap_err(), error!(VaultError::BadRewardMint));
        assert!(reward_mint_ok(&mint_with(&[ExtensionType::MetadataPointer, ExtensionType::TransferFeeConfig])).is_err());
        // A plain SPL Token mint (82 bytes, no extensions) is fine; garbage isn't.
        let mut plain = vec![0u8; MintState::LEN];
        MintState { decimals: 6, is_initialized: true, supply: 1, ..Default::default() }.pack_into_slice(&mut plain);
        assert!(reward_mint_ok(&plain).is_ok());
        assert!(reward_mint_ok(&[0u8; 10]).is_err());
        assert!(reward_mint_ok(&vec![0u8; MintState::LEN]).is_err());

        // Payout tokens: the same extension rules, and no freeze authority either.
        assert!(payout_mint_ok(&plain).is_ok());
        assert!(payout_mint_ok(&mint_with(&[ExtensionType::MetadataPointer])).is_ok());
        assert_eq!(payout_mint_ok(&mint_with(&[ExtensionType::TransferFeeConfig])).unwrap_err(), error!(VaultError::BadPayoutMint));
        let mut frozen = vec![0u8; MintState::LEN];
        MintState { decimals: 6, is_initialized: true, supply: 1, freeze_authority: COption::Some(Pubkey::new_unique()), ..Default::default() }
            .pack_into_slice(&mut frozen);
        assert!(reward_mint_ok(&frozen).is_ok(), "the creator reward token may have one (USDC.X does)");
        assert_eq!(payout_mint_ok(&frozen).unwrap_err(), error!(VaultError::BadPayoutMint));
    }

    #[test]
    fn payout_fields_and_what_auth_must_hold() {
        // The payout fields sit in the v3 reserved bytes: 580 pool, 612 unswapped XNT, 620.. reserved.
        let mut v = filled();
        v.payout_pool = Pubkey::new_from_array([0x51; 32]);
        v.xnt_holders = 0x52;
        let mut buf = Vec::new();
        v.try_serialize(&mut buf).unwrap();
        assert_eq!(buf.len(), VAULT_V3_LEN);
        assert_eq!(&buf[580..612], &[0x51; 32]);
        assert_eq!(u64::from_le_bytes(buf[612..620].try_into().unwrap()), 0x52);
        assert_eq!(&buf[620..640], &[0x2e; 20]);

        // XNT vault: auth holds the LP and creator XNT plus what holders are still owed.
        let mut v = filled();
        v.payout_pool = Pubkey::default();
        (v.xnt_lp, v.xnt_creator, v.holders_funded, v.holders_paid, v.xnt_holders) = (10, 20, 100, 40, 7);
        assert_eq!(promised(&v).unwrap(), 10 + 20 + 60);
        // Payout-token vault: holders are owed tokens (checked separately); auth holds only the unswapped XNT.
        v.payout_pool = Pubkey::new_unique();
        assert_eq!(promised(&v).unwrap(), 10 + 20 + 7);
        v.holders_paid = 101;
        assert!(promised(&v).is_err(), "paid can never pass funded");
    }
}
