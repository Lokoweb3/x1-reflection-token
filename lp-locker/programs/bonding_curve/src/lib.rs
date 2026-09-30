//! 99 + Tax launchpad bonding curve (spec: docs/bonding-curve-spec.md).
//!
//! * `create_curve` takes a fresh Token-2022 tax token whose mint authority is this
//!   curve's `auth` PDA and whose supply is 0. 80% of the supply (`T`) is sold on a
//!   virtual constant-product curve; no tokens exist until graduation, so buyers' balances
//!   live in `Position` accounts and no transfer tax applies while trading.
//! * `buy` / `sell` move XNT between traders and `auth` (a system-owned, never-allocated
//!   PDA that holds every lamport of the curve). 1% of each trade goes to `FEE_RECEIVER`.
//! * The buy that reaches `T` is filled exactly to `T` and completes the curve.
//! * `graduate_pool` mints the pool's share to `auth`, wraps the curve's `target_xnt` (chosen
//!   at creation from `TARGETS_XNT_WHOLE`) and creates the XDEX pool with `auth` as creator. The virtual reserves are chosen so the pool opens at
//!   the curve's final price. `graduate_lock` locks all the LP forever in `lp_locker`, gives
//!   the lock NFT to the creator and pays the caller a small reward.
//! * `deliver` mints each buyer's tokens to their wallet; after the last one the mint
//!   authority is revoked and what is left in `auth` goes to the creator.
//!
//! Lamport accounting: `auth` holds GRADUATION_DEPOSIT + raised_xnt + every open
//! position's deposit (plus anything donated). Every rounding favours the curve.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_option::COption,
    system_instruction,
};
use anchor_lang::system_program;
use anchor_spl::associated_token::{self, get_associated_token_address_with_program_id, AssociatedToken, Create as CreateIdempotent};
use anchor_spl::token::{self, spl_token::native_mint, Token};
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        transfer_fee::{TransferFee, TransferFeeConfig},
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    instruction::AuthorityType,
    state::{Account as TokenAccountState, Mint as MintState},
};
use anchor_spl::token_2022::{self as token_2022, Token2022};
use anchor_spl::token_2022_extensions::{
    metadata_pointer_initialize, spl_pod::optional_keys::OptionalNonZeroPubkey,
    spl_token_metadata_interface::state::TokenMetadata, token_metadata_initialize, MetadataPointerInitialize,
    TokenMetadataInitialize,
};

declare_id!("CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY");

pub const LOCKER_PROGRAM_ID: Pubkey = pubkey!("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");

#[cfg(feature = "testnet")]
pub const XDEX_PROGRAM_ID: Pubkey = pubkey!("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
#[cfg(not(feature = "testnet"))]
pub const XDEX_PROGRAM_ID: Pubkey = pubkey!("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");

#[cfg(feature = "testnet")]
pub const XDEX_AMM_CONFIG: Pubkey = pubkey!("3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY");
#[cfg(not(feature = "testnet"))]
pub const XDEX_AMM_CONFIG: Pubkey = pubkey!("2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c");

#[cfg(feature = "testnet")]
pub const XDEX_CREATE_POOL_FEE: Pubkey = pubkey!("DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS");
#[cfg(not(feature = "testnet"))]
pub const XDEX_CREATE_POOL_FEE: Pubkey = pubkey!("SKc6b6zAv2kkB9EtitjppbzPVR48bCMfRtE5B8KDuF1");

pub const FEE_RECEIVER: Pubkey = pubkey!("53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy");
pub const FEE_BPS: u64 = 100;
pub const CURVE_BPS: u64 = 8000;
/// Graduation targets a creator may pick (whole XNT that goes into the pool). Each curve
/// stores its own in `target_xnt` (lamports); curves made before this list existed keep
/// their stored 20 XNT.
/// The testnet build also offers 10 and 20 XNT, so a curve can be graduated with faucet XNT.
#[cfg(feature = "testnet")]
pub const TARGETS_XNT_WHOLE: [u64; 7] = [10, 20, 500, 1_000, 3_000, 5_000, 10_000];
#[cfg(not(feature = "testnet"))]
pub const TARGETS_XNT_WHOLE: [u64; 5] = [500, 1_000, 3_000, 5_000, 10_000];
/// Paid by the creator in `create_curve`: XDEX's pool fee, rents and the reward. The rest
/// goes back to the creator when the curve finishes.
pub const GRADUATION_DEPOSIT: u64 = 300_000_000;
pub const GRADUATE_REWARD: u64 = 10_000_000;
#[cfg(not(feature = "short-windows"))]
pub const SNIPE_WINDOW_SECS: i64 = 120;
/// Local testing only.
#[cfg(feature = "short-windows")]
pub const SNIPE_WINDOW_SECS: i64 = 5;
pub const SNIPE_MAX_BPS: u64 = 100;
pub const DECIMALS: u8 = 9;
pub const MIN_SUPPLY_WHOLE: u64 = 1_000;
pub const MAX_SUPPLY_WHOLE: u64 = 10_000_000_000;
pub const MIN_TAX_BPS: u16 = 100;
pub const MAX_TAX_BPS: u16 = 1000;

pub const STATUS_TRADING: u8 = 0;
pub const STATUS_COMPLETE: u8 = 1;
pub const STATUS_POOL_CREATED: u8 = 2;
pub const STATUS_GRADUATED: u8 = 3;
pub const STATUS_FINISHED: u8 = 4;

pub const NFT_NAME: &str = "99 + Tax LP Lock";
pub const NFT_SYMBOL: &str = "LPLOCK";
pub const NFT_URI: &str = "";

/// sha256("global:initialize")[..8] (XDEX pool creation).
const XDEX_INITIALIZE_DISC: [u8; 8] = [0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed];
/// sha256("global:lock")[..8] (lp_locker forever lock).
const LOCKER_LOCK_DISC: [u8; 8] = [0x15, 0x13, 0xd0, 0x2b, 0xed, 0x3e, 0xff, 0x57];

#[program]
pub mod bonding_curve {
    use super::*;

    /// Open a curve for `mint` (see `check_curve_mint` for what the mint must look like)
    /// that graduates at `target_whole` XNT, one of `TARGETS_XNT_WHOLE`.
    pub fn create_curve(ctx: Context<CreateCurve>, supply_whole: u64, target_whole: u64) -> Result<()> {
        require!((MIN_SUPPLY_WHOLE..=MAX_SUPPLY_WHOLE).contains(&supply_whole), CurveError::BadSupply);
        let supply = supply_whole.checked_mul(10u64.pow(DECIMALS as u32)).ok_or(CurveError::BadSupply)?;
        let target = target_lamports(target_whole)?;
        let fee = check_curve_mint(&ctx.accounts.mint.to_account_info(), &ctx.accounts.auth.key(), &ctx.accounts.creator.key())?;
        let s = math::setup(supply, target, |a| fee.calculate_fee(a))?;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.auth.to_account_info(),
                },
            ),
            GRADUATION_DEPOSIT,
        )?;

        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.curve;
        c.mint = ctx.accounts.mint.key();
        c.creator = ctx.accounts.creator.key();
        c.supply = supply;
        c.curve_tokens = s.t;
        c.pool_tokens_gross = s.pg;
        c.pool_tokens_net = s.pn;
        c.target_xnt = target;
        c.virtual_xnt = s.x0;
        c.virtual_tokens = s.y0;
        c.tokens_sold = 0;
        c.raised_xnt = 0;
        c.created_at = now;
        c.status = STATUS_TRADING;
        c.positions = 0;
        c.delivered = 0;
        c.pool = Pubkey::default();
        c.lock_nft = Pubkey::default();
        c.tax_bps = u16::from(fee.transfer_fee_basis_points);
        c.bump = ctx.bumps.curve;
        c.auth_bump = ctx.bumps.auth;
        emit!(CurveCreated {
            curve: c.key(),
            mint: c.mint,
            creator: c.creator,
            supply,
            x0: s.x0,
            y0: s.y0,
            created_at: now,
        });
        Ok(())
    }

    /// Spend up to `xnt_in` lamports (1% fee included) for at least `min_tokens_out`.
    pub fn buy(ctx: Context<Buy>, xnt_in: u64, min_tokens_out: u64) -> Result<()> {
        let curve = &ctx.accounts.curve;
        require!(curve.status == STATUS_TRADING, CurveError::NotTrading);
        require_keys_neq!(ctx.accounts.buyer.key(), curve.creator, CurveError::CreatorCannotBuy);
        require!(xnt_in > 0, CurveError::ZeroAmount);

        let q = math::buy(curve.virtual_xnt, curve.virtual_tokens, curve.k0()?, curve.tokens_sold, curve.curve_tokens, xnt_in)?;
        require!(q.out > 0, CurveError::ZeroAmount);
        require!(q.out >= min_tokens_out, CurveError::Slippage);
        let now = Clock::get()?.unix_timestamp;
        if now < curve.created_at.saturating_add(SNIPE_WINDOW_SECS) {
            let cap = (curve.supply as u128 * SNIPE_MAX_BPS as u128 / 10_000) as u64;
            require!(q.out <= cap, CurveError::TooBigEarly);
        }

        // First buy: open the position and take a deposit for the buyer's token account.
        let mut deposit = 0u64;
        if ctx.accounts.position.owner == Pubkey::default() {
            deposit = token_account_rent()?;
            let p = &mut ctx.accounts.position;
            p.curve = ctx.accounts.curve.key();
            p.owner = ctx.accounts.buyer.key();
            p.balance = 0;
            p.deposit = deposit;
            p.bump = ctx.bumps.position;
            let c = &mut ctx.accounts.curve;
            c.positions = c.positions.checked_add(1).ok_or(CurveError::MathOverflow)?;
        }

        let to_auth = q.net.checked_add(deposit).ok_or(CurveError::MathOverflow)?;
        let sys = ctx.accounts.system_program.to_account_info();
        let buyer = ctx.accounts.buyer.to_account_info();
        if to_auth > 0 {
            system_program::transfer(
                CpiContext::new(sys.clone(), system_program::Transfer { from: buyer.clone(), to: ctx.accounts.auth.to_account_info() }),
                to_auth,
            )?;
        }
        if q.fee > 0 {
            system_program::transfer(
                CpiContext::new(sys, system_program::Transfer { from: buyer, to: ctx.accounts.fee_receiver.to_account_info() }),
                q.fee,
            )?;
        }

        let c = &mut ctx.accounts.curve;
        c.virtual_xnt = q.x;
        c.virtual_tokens = q.y;
        c.tokens_sold = c.tokens_sold.checked_add(q.out).ok_or(CurveError::MathOverflow)?;
        c.raised_xnt = c.raised_xnt.checked_add(q.net).ok_or(CurveError::MathOverflow)?;
        if q.complete {
            require!(c.tokens_sold == c.curve_tokens, CurveError::MathOverflow);
            c.status = STATUS_COMPLETE;
        }
        let p = &mut ctx.accounts.position;
        p.balance = p.balance.checked_add(q.out).ok_or(CurveError::MathOverflow)?;
        emit!(Trade {
            curve: c.key(),
            trader: p.owner,
            is_buy: true,
            xnt: q.xnt_in,
            fee: q.fee,
            tokens: q.out,
            virtual_xnt: c.virtual_xnt,
            virtual_tokens: c.virtual_tokens,
            tokens_sold: c.tokens_sold,
            raised_xnt: c.raised_xnt,
            ts: now,
        });
        Ok(())
    }

    /// Sell `tokens_in` of the seller's position back to the curve for at least `min_xnt_out`
    /// lamports (after the 1% fee).
    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_xnt_out: u64) -> Result<()> {
        let curve = &ctx.accounts.curve;
        require!(curve.status == STATUS_TRADING, CurveError::NotTrading);
        require!(tokens_in > 0, CurveError::ZeroAmount);
        require!(ctx.accounts.position.balance >= tokens_in, CurveError::InsufficientBalance);

        let q = math::sell(curve.virtual_xnt, curve.virtual_tokens, curve.k0()?, tokens_in)?;
        require!(q.gross > 0, CurveError::ZeroAmount);
        require!(q.out >= min_xnt_out, CurveError::Slippage);

        let mint = curve.mint;
        let seeds: &[&[u8]] = &[b"auth", mint.as_ref(), &[curve.auth_bump]];
        let sys = ctx.accounts.system_program.to_account_info();
        let auth = ctx.accounts.auth.to_account_info();
        pay_from_auth(&sys, &auth, &ctx.accounts.seller.to_account_info(), q.out, seeds)?;
        pay_from_auth(&sys, &auth, &ctx.accounts.fee_receiver.to_account_info(), q.fee, seeds)?;

        let c = &mut ctx.accounts.curve;
        c.virtual_xnt = q.x;
        c.virtual_tokens = q.y;
        c.tokens_sold = c.tokens_sold.checked_sub(tokens_in).ok_or(CurveError::MathOverflow)?;
        c.raised_xnt = c.raised_xnt.checked_sub(q.gross).ok_or(CurveError::MathOverflow)?;
        let p = &mut ctx.accounts.position;
        p.balance -= tokens_in;
        emit!(Trade {
            curve: c.key(),
            trader: p.owner,
            is_buy: false,
            xnt: q.gross,
            fee: q.fee,
            tokens: tokens_in,
            virtual_xnt: c.virtual_xnt,
            virtual_tokens: c.virtual_tokens,
            tokens_sold: c.tokens_sold,
            raised_xnt: c.raised_xnt,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Complete -> PoolCreated: mint the pool's tokens to `auth`, wrap the curve's target_xnt
    /// and create the XDEX pool with `auth` as its creator.
    pub fn graduate_pool(ctx: Context<GraduatePool>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.curve.status == STATUS_COMPLETE, CurveError::WrongStatus);
        let mint = a.curve.mint;
        let auth_seeds: &[&[u8]] = &[b"auth", mint.as_ref(), &[a.curve.auth_bump]];
        let (mint0, mint1) = sorted_mints(&mint);
        let expected_pool = Pubkey::find_program_address(
            &[b"pool", XDEX_AMM_CONFIG.as_ref(), mint0.as_ref(), mint1.as_ref()],
            &XDEX_PROGRAM_ID,
        )
        .0;
        require_keys_eq!(a.pool.key(), expected_pool, CurveError::WrongAccount);

        let auth = a.auth.to_account_info();
        let sys = a.system_program.to_account_info();
        let t22 = a.token_2022_program.to_account_info();
        let tok = a.token_program.to_account_info();

        // Pool tokens, minted to auth's Token-2022 account.
        create_ata(&a.associated_token_program, &auth, &a.auth_token, &auth, &a.mint, &sys, &t22, auth_seeds)?;
        token_2022::mint_to(
            CpiContext::new_with_signer(
                t22.clone(),
                token_2022::MintTo { mint: a.mint.to_account_info(), to: a.auth_token.to_account_info(), authority: auth.clone() },
                &[auth_seeds],
            ),
            a.curve.pool_tokens_gross,
        )?;

        // The curve's own target (20 XNT for curves made before targets were selectable), wrapped.
        let (pool_tokens, pool_xnt) = pool_amounts(&a.curve);
        create_ata(&a.associated_token_program, &auth, &a.auth_wxnt, &auth, &a.native_mint, &sys, &tok, auth_seeds)?;
        pay_from_auth(&sys, &auth, &a.auth_wxnt.to_account_info(), pool_xnt, auth_seeds)?;
        token::sync_native(CpiContext::new(tok.clone(), token::SyncNative { account: a.auth_wxnt.to_account_info() }))?;

        // XDEX `initialize`, same accounts and data as buildCreatePool in src/xdex.ts.
        let token_is_0 = mint0 == mint;
        let (amount0, amount1) = if token_is_0 { (pool_tokens, pool_xnt) } else { (pool_xnt, pool_tokens) };
        let mut data = Vec::with_capacity(32);
        data.extend_from_slice(&XDEX_INITIALIZE_DISC);
        data.extend_from_slice(&amount0.to_le_bytes());
        data.extend_from_slice(&amount1.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes()); // open_time: now
        let (mint0_info, mint1_info, acc0, acc1, prog0, prog1) = if token_is_0 {
            (a.mint.to_account_info(), a.native_mint.to_account_info(), a.auth_token.to_account_info(), a.auth_wxnt.to_account_info(), t22.clone(), tok.clone())
        } else {
            (a.native_mint.to_account_info(), a.mint.to_account_info(), a.auth_wxnt.to_account_info(), a.auth_token.to_account_info(), tok.clone(), t22.clone())
        };
        let ix = Instruction {
            program_id: XDEX_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(auth.key(), true),
                AccountMeta::new_readonly(a.amm_config.key(), false),
                AccountMeta::new_readonly(a.xdex_authority.key(), false),
                AccountMeta::new(a.pool.key(), false),
                AccountMeta::new_readonly(mint0_info.key(), false),
                AccountMeta::new_readonly(mint1_info.key(), false),
                AccountMeta::new(a.lp_mint.key(), false),
                AccountMeta::new(acc0.key(), false),
                AccountMeta::new(acc1.key(), false),
                AccountMeta::new(a.auth_lp.key(), false),
                AccountMeta::new(a.vault0.key(), false),
                AccountMeta::new(a.vault1.key(), false),
                AccountMeta::new(a.create_pool_fee.key(), false),
                AccountMeta::new(a.observation.key(), false),
                AccountMeta::new_readonly(tok.key(), false),
                AccountMeta::new_readonly(prog0.key(), false),
                AccountMeta::new_readonly(prog1.key(), false),
                AccountMeta::new_readonly(a.associated_token_program.key(), false),
                AccountMeta::new_readonly(sys.key(), false),
                AccountMeta::new_readonly(a.rent.key(), false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                auth.clone(),
                a.amm_config.to_account_info(),
                a.xdex_authority.to_account_info(),
                a.pool.to_account_info(),
                mint0_info,
                mint1_info,
                a.lp_mint.to_account_info(),
                acc0,
                acc1,
                a.auth_lp.to_account_info(),
                a.vault0.to_account_info(),
                a.vault1.to_account_info(),
                a.create_pool_fee.to_account_info(),
                a.observation.to_account_info(),
                tok.clone(),
                t22.clone(),
                a.associated_token_program.to_account_info(),
                sys.clone(),
                a.rent.to_account_info(),
                a.xdex_program.to_account_info(),
            ],
            &[auth_seeds],
        )?;

        // The two funding accounts are empty now: close them so their rent comes back.
        token::close_account(CpiContext::new_with_signer(
            tok,
            token::CloseAccount { account: a.auth_wxnt.to_account_info(), destination: auth.clone(), authority: auth.clone() },
            &[auth_seeds],
        ))?;
        token_2022::close_account(CpiContext::new_with_signer(
            t22,
            token_2022::CloseAccount { account: a.auth_token.to_account_info(), destination: auth.clone(), authority: auth.clone() },
            &[auth_seeds],
        ))?;

        let pool = a.pool.key();
        let c = &mut ctx.accounts.curve;
        c.pool = pool;
        c.status = STATUS_POOL_CREATED;
        check_reserve(&ctx.accounts.auth.to_account_info(), ctx.accounts.curve.positions)
    }

    /// PoolCreated -> Graduated: lock all of auth's LP forever in lp_locker, send the lock
    /// NFT to the creator and pay the caller GRADUATE_REWARD.
    pub fn graduate_lock(ctx: Context<GraduateLock>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.curve.status == STATUS_POOL_CREATED, CurveError::WrongStatus);
        let mint = a.curve.mint;
        let curve_key = a.curve.key();
        let auth_seeds: &[&[u8]] = &[b"auth", mint.as_ref(), &[a.curve.auth_bump]];
        let nft_seeds: &[&[u8]] = &[b"nft", curve_key.as_ref(), &[ctx.bumps.nft_mint]];
        let auth = a.auth.to_account_info();
        let sys = a.system_program.to_account_info();
        let t22 = a.token_2022_program.to_account_info();
        let tok = a.token_program.to_account_info();
        let nft = a.nft_mint.to_account_info();
        let creator = a.creator.to_account_info();

        // 1. The NFT mint: decimals 0, mint authority auth, no freeze, metadata on the mint.
        let metadata = TokenMetadata {
            update_authority: OptionalNonZeroPubkey::try_from(Some(creator.key()))?,
            mint: nft.key(),
            name: NFT_NAME.to_string(),
            symbol: NFT_SYMBOL.to_string(),
            uri: NFT_URI.to_string(),
            additional_metadata: vec![],
        };
        let mint_len = ExtensionType::try_calculate_account_len::<MintState>(&[ExtensionType::MetadataPointer])?;
        let lamports = Rent::get()?.minimum_balance(mint_len + metadata.tlv_size_of()?);
        create_pda_account(&auth, &nft, &sys, lamports, mint_len as u64, &token_2022::ID, auth_seeds, nft_seeds)?;
        metadata_pointer_initialize(
            CpiContext::new(t22.clone(), MetadataPointerInitialize { token_program_id: t22.clone(), mint: nft.clone() }),
            Some(creator.key()),
            Some(nft.key()),
        )?;
        token_2022::initialize_mint2(
            CpiContext::new(t22.clone(), token_2022::InitializeMint2 { mint: nft.clone() }),
            0,
            &auth.key(),
            None,
        )?;
        token_metadata_initialize(
            CpiContext::new_with_signer(
                t22.clone(),
                TokenMetadataInitialize {
                    program_id: t22.clone(),
                    metadata: nft.clone(),
                    update_authority: creator.clone(),
                    mint_authority: auth.clone(),
                    mint: nft.clone(),
                },
                &[auth_seeds],
            ),
            metadata.name,
            metadata.symbol,
            metadata.uri,
        )?;
        create_ata(&a.associated_token_program, &auth, &a.auth_nft, &auth, &a.nft_mint, &sys, &t22, auth_seeds)?;

        // 2. lp_locker::lock(all of auth's LP) with owner = auth.
        let lp_amount = token_amount(&a.auth_lp, &token::ID)?;
        require!(lp_amount > 0, CurveError::ZeroAmount);
        let mut data = Vec::with_capacity(16);
        data.extend_from_slice(&LOCKER_LOCK_DISC);
        data.extend_from_slice(&lp_amount.to_le_bytes());
        let ix = Instruction {
            program_id: LOCKER_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(auth.key(), true),
                AccountMeta::new_readonly(a.pool.key(), false),
                AccountMeta::new_readonly(a.token_0_vault.key(), false),
                AccountMeta::new_readonly(a.token_1_vault.key(), false),
                AccountMeta::new_readonly(a.lp_mint.key(), false),
                AccountMeta::new(a.auth_lp.key(), false),
                AccountMeta::new(nft.key(), false),
                AccountMeta::new(a.auth_nft.key(), false),
                AccountMeta::new(a.lock.key(), false),
                AccountMeta::new(a.lock_vault.key(), false),
                AccountMeta::new_readonly(tok.key(), false),
                AccountMeta::new_readonly(t22.key(), false),
                AccountMeta::new_readonly(sys.key(), false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                auth.clone(),
                a.pool.to_account_info(),
                a.token_0_vault.to_account_info(),
                a.token_1_vault.to_account_info(),
                a.lp_mint.to_account_info(),
                a.auth_lp.to_account_info(),
                nft.clone(),
                a.auth_nft.to_account_info(),
                a.lock.to_account_info(),
                a.lock_vault.to_account_info(),
                tok.clone(),
                t22.clone(),
                sys.clone(),
                a.locker_program.to_account_info(),
            ],
            &[auth_seeds],
        )?;
        require!(token_amount(&a.auth_lp, &token::ID)? == 0, CurveError::WrongAccount);
        require!(token_amount(&a.auth_nft, &token_2022::ID)? == 1, CurveError::WrongAccount);

        // 3. The NFT goes to the creator; auth's two empty token accounts are closed.
        create_ata(&a.associated_token_program, &auth, &a.creator_nft, &creator, &a.nft_mint, &sys, &t22, auth_seeds)?;
        token_2022::transfer_checked(
            CpiContext::new_with_signer(
                t22.clone(),
                token_2022::TransferChecked {
                    from: a.auth_nft.to_account_info(),
                    mint: nft.clone(),
                    to: a.creator_nft.to_account_info(),
                    authority: auth.clone(),
                },
                &[auth_seeds],
            ),
            1,
            0,
        )?;
        token_2022::close_account(CpiContext::new_with_signer(
            t22,
            token_2022::CloseAccount { account: a.auth_nft.to_account_info(), destination: auth.clone(), authority: auth.clone() },
            &[auth_seeds],
        ))?;
        token::close_account(CpiContext::new_with_signer(
            tok,
            token::CloseAccount { account: a.auth_lp.to_account_info(), destination: auth.clone(), authority: auth.clone() },
            &[auth_seeds],
        ))?;

        // 4. Reward the caller.
        pay_from_auth(&sys, &auth, &a.caller.to_account_info(), GRADUATE_REWARD, auth_seeds)?;

        let (pool, nft_key) = (a.pool.key(), nft.key());
        let c = &mut ctx.accounts.curve;
        c.lock_nft = nft_key;
        c.status = STATUS_GRADUATED;
        emit!(Graduated { curve: c.key(), mint: c.mint, pool, lock_nft: nft_key, raised_xnt: c.raised_xnt });
        check_reserve(&ctx.accounts.auth.to_account_info(), ctx.accounts.curve.positions)
    }

    /// Mint a position's tokens to its owner, refund the unused deposit and close the
    /// position. The last delivery revokes the mint authority and pays what is left in
    /// `auth` to the creator.
    pub fn deliver(ctx: Context<Deliver>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.curve.status == STATUS_GRADUATED, CurveError::WrongStatus);
        let mint = a.curve.mint;
        let auth_seeds: &[&[u8]] = &[b"auth", mint.as_ref(), &[a.curve.auth_bump]];
        let auth = a.auth.to_account_info();
        let sys = a.system_program.to_account_info();
        let t22 = a.token_2022_program.to_account_info();
        let balance = a.position.balance;

        let mut cost = 0u64;
        if balance > 0 {
            let before = auth.lamports();
            create_ata(&a.associated_token_program, &auth, &a.owner_token, &a.owner, &a.mint, &sys, &t22, auth_seeds)?;
            cost = before.checked_sub(auth.lamports()).ok_or(CurveError::MathOverflow)?;
            token_2022::mint_to(
                CpiContext::new_with_signer(
                    t22.clone(),
                    token_2022::MintTo { mint: a.mint.to_account_info(), to: a.owner_token.to_account_info(), authority: auth.clone() },
                    &[auth_seeds],
                ),
                balance,
            )?;
        }
        let refund = a.position.deposit.saturating_sub(cost);
        pay_from_auth(&sys, &auth, &a.owner.to_account_info(), refund, auth_seeds)?;
        emit!(Delivered { curve: a.curve.key(), owner: a.owner.key(), tokens: balance });

        let c = &mut ctx.accounts.curve;
        c.positions = c.positions.checked_sub(1).ok_or(CurveError::MathOverflow)?;
        c.delivered = c.delivered.checked_add(balance).ok_or(CurveError::MathOverflow)?;
        if c.positions == 0 {
            require!(c.delivered == c.curve_tokens, CurveError::MathOverflow);
            c.status = STATUS_FINISHED;
            let a = &ctx.accounts;
            token_2022::set_authority(
                CpiContext::new_with_signer(
                    t22,
                    token_2022::SetAuthority { current_authority: auth.clone(), account_or_mint: a.mint.to_account_info() },
                    &[auth_seeds],
                ),
                AuthorityType::MintTokens,
                None,
            )?;
            let rest = auth.lamports();
            pay_from_auth(&sys, &auth, &a.creator.to_account_info(), rest, auth_seeds)?;
        }
        Ok(()) // `close = owner` closes the position
    }
}

// ---------- Helpers ----------

/// A creator's graduation target in lamports; `BadTarget` unless it is in TARGETS_XNT_WHOLE.
pub fn target_lamports(target_whole: u64) -> Result<u64> {
    require!(TARGETS_XNT_WHOLE.contains(&target_whole), CurveError::BadTarget);
    target_whole.checked_mul(10u64.pow(DECIMALS as u32)).ok_or_else(|| error!(CurveError::BadTarget))
}

/// What graduate_pool deposits into XDEX: (tokens before the transfer fee, XNT lamports).
/// The XNT is the curve's stored target, so curves of every target (and those made with
/// the old fixed 20 XNT) graduate with their own.
pub fn pool_amounts(curve: &Curve) -> (u64, u64) {
    (curve.pool_tokens_gross, curve.target_xnt)
}

/// The mint must be a fresh 9-decimal Token-2022 tax token that only this curve's `auth`
/// can mint: supply 0, no freeze authority, only TransferFeeConfig / MetadataPointer /
/// TokenMetadata, an immutable fee of 100..=1000 bps, and token metadata whose update
/// authority is the creator (so nobody else can open a curve on someone's new mint).
fn check_curve_mint(mint: &AccountInfo, auth: &Pubkey, creator: &Pubkey) -> Result<TransferFee> {
    require_keys_eq!(*mint.owner, token_2022::ID, CurveError::BadMint);
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data).map_err(|_| error!(CurveError::BadMint))?;
    let m = &state.base;
    require!(m.is_initialized && m.decimals == DECIMALS && m.supply == 0, CurveError::BadMint);
    require!(m.mint_authority == COption::Some(*auth), CurveError::BadMint);
    require!(m.freeze_authority.is_none(), CurveError::BadMint);
    for ext in state.get_extension_types().map_err(|_| error!(CurveError::BadMint))? {
        require!(
            matches!(ext, ExtensionType::TransferFeeConfig | ExtensionType::MetadataPointer | ExtensionType::TokenMetadata),
            CurveError::BadMint
        );
    }
    let cfg = state.get_extension::<TransferFeeConfig>().map_err(|_| error!(CurveError::BadTax))?;
    let cfg_authority: Option<Pubkey> = cfg.transfer_fee_config_authority.into();
    require!(cfg_authority.is_none(), CurveError::BadTax);
    let fee = cfg.newer_transfer_fee;
    require!(
        fee.transfer_fee_basis_points == cfg.older_transfer_fee.transfer_fee_basis_points
            && fee.maximum_fee == cfg.older_transfer_fee.maximum_fee,
        CurveError::BadTax
    );
    let bps = u16::from(fee.transfer_fee_basis_points);
    require!((MIN_TAX_BPS..=MAX_TAX_BPS).contains(&bps), CurveError::BadTax);
    let md = state.get_variable_len_extension::<TokenMetadata>().map_err(|_| error!(CurveError::BadMint))?;
    let update_authority: Option<Pubkey> = md.update_authority.into();
    require!(update_authority == Some(*creator), CurveError::BadMint);
    Ok(fee)
}

/// Rent of a Token-2022 associated token account for a transfer-fee mint.
fn token_account_rent() -> Result<u64> {
    let len = ExtensionType::try_calculate_account_len::<TokenAccountState>(&[
        ExtensionType::ImmutableOwner,
        ExtensionType::TransferFeeAmount,
    ])?;
    Ok(Rent::get()?.minimum_balance(len))
}

/// After graduation steps, `auth` must still cover every open position's deposit and stay
/// rent-exempt (anyone can top it up if a network cost ever outgrows GRADUATION_DEPOSIT).
fn check_reserve(auth: &AccountInfo, positions: u32) -> Result<()> {
    let need = (positions as u64)
        .checked_mul(token_account_rent()?)
        .and_then(|v| v.checked_add(Rent::get().ok()?.minimum_balance(0)))
        .ok_or(CurveError::MathOverflow)?;
    require!(auth.lamports() >= need, CurveError::InsufficientReserve);
    Ok(())
}

fn sorted_mints(mint: &Pubkey) -> (Pubkey, Pubkey) {
    let native = native_mint::ID;
    if native.to_bytes() < mint.to_bytes() {
        (native, *mint)
    } else {
        (*mint, native)
    }
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

#[allow(clippy::too_many_arguments)]
fn create_ata<'info>(
    ata_program: &Program<'info, AssociatedToken>,
    payer: &AccountInfo<'info>,
    ata: &UncheckedAccount<'info>,
    authority: &AccountInfo<'info>,
    mint: &UncheckedAccount<'info>,
    system: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    associated_token::create_idempotent(CpiContext::new_with_signer(
        ata_program.to_account_info(),
        CreateIdempotent {
            payer: payer.clone(),
            associated_token: ata.to_account_info(),
            authority: authority.clone(),
            mint: mint.to_account_info(),
            system_program: system.clone(),
            token_program: token_program.clone(),
        },
        &[seeds],
    ))
}

/// Create a PDA account paid by `auth`, also when someone pre-funded the address.
#[allow(clippy::too_many_arguments)]
fn create_pda_account<'info>(
    auth: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    lamports: u64,
    space: u64,
    owner: &Pubkey,
    auth_seeds: &[&[u8]],
    target_seeds: &[&[u8]],
) -> Result<()> {
    let current = target.lamports();
    let infos = [auth.clone(), target.clone(), system.clone()];
    if current == 0 {
        invoke_signed(
            &system_instruction::create_account(auth.key, target.key, lamports, space, owner),
            &infos,
            &[auth_seeds, target_seeds],
        )?;
    } else {
        require_keys_eq!(*target.owner, system_program::ID, CurveError::WrongAccount);
        if current < lamports {
            invoke_signed(&system_instruction::transfer(auth.key, target.key, lamports - current), &infos, &[auth_seeds])?;
        }
        invoke_signed(&system_instruction::allocate(target.key, space), &infos, &[target_seeds])?;
        invoke_signed(&system_instruction::assign(target.key, owner), &infos, &[target_seeds])?;
    }
    Ok(())
}

/// Amount of an SPL Token / Token-2022 account owned by `program`.
fn token_amount(acc: &AccountInfo, program: &Pubkey) -> Result<u64> {
    require_keys_eq!(*acc.owner, *program, CurveError::WrongAccount);
    let d = acc.try_borrow_data()?;
    require!(d.len() >= 72, CurveError::WrongAccount);
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

fn ata(owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, program)
}

// ---------- Curve maths ----------

pub mod math {
    use super::{CurveError, CURVE_BPS, FEE_BPS};
    use anchor_lang::prelude::*;

    pub fn ceil_div(a: u128, b: u128) -> Result<u128> {
        require!(b > 0, CurveError::MathOverflow);
        Ok(a / b + u128::from(a % b != 0))
    }

    fn to_u64(v: u128) -> Result<u64> {
        u64::try_from(v).map_err(|_| error!(CurveError::MathOverflow))
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Setup {
        pub t: u64,
        pub pg: u64,
        pub pn: u64,
        pub a: u64,
        pub x0: u64,
        pub y0: u64,
    }

    /// Initial virtual reserves: selling exactly T raises R and ends at the price the pool
    /// opens at (R / Pn). `transfer_fee(Pg)` is the Token-2022 fee on the pool deposit.
    pub fn setup(supply: u64, r: u64, transfer_fee: impl Fn(u64) -> Option<u64>) -> Result<Setup> {
        let s = supply as u128;
        let t = s * CURVE_BPS as u128 / 10_000;
        let pg = s - t;
        let fee = transfer_fee(pg as u64).ok_or(CurveError::MathOverflow)? as u128;
        let pn = pg.checked_sub(fee).ok_or(CurveError::MathOverflow)?;
        require!(pn > 0 && t > pn, CurveError::BadSupply);
        let a = pn.checked_mul(t).ok_or(CurveError::MathOverflow)? / (t - pn);
        let y0 = a.checked_add(t).ok_or(CurveError::MathOverflow)?;
        let x0 = (r as u128).checked_mul(a - pn).ok_or(CurveError::MathOverflow)? / pn;
        require!(x0 > 0 && a > 0, CurveError::BadSupply);
        x0.checked_mul(y0).ok_or(CurveError::MathOverflow)?;
        Ok(Setup { t: to_u64(t)?, pg: to_u64(pg)?, pn: to_u64(pn)?, a: to_u64(a)?, x0: to_u64(x0)?, y0: to_u64(y0)? })
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct BuyQuote {
        pub xnt_in: u64,
        pub fee: u64,
        pub net: u64,
        pub out: u64,
        /// New virtual reserves.
        pub x: u64,
        pub y: u64,
        pub complete: bool,
    }

    pub fn buy(x: u64, y: u64, k0: u128, tokens_sold: u64, t: u64, xnt_in: u64) -> Result<BuyQuote> {
        let mut fee = ceil_div(xnt_in as u128 * FEE_BPS as u128, 10_000)? as u64;
        let mut net = xnt_in - fee;
        let mut xnt_in = xnt_in;
        let new_x = x as u128 + net as u128;
        let y1 = ceil_div(k0, new_x)?;
        let mut out = to_u64((y as u128).saturating_sub(y1))?;
        let left = t.checked_sub(tokens_sold).ok_or(CurveError::MathOverflow)?;
        let mut complete = false;
        if out >= left {
            // Last buy: fill exactly to T and charge only what that costs.
            out = left;
            let end_y = y.checked_sub(out).ok_or(CurveError::MathOverflow)?;
            let end_x = ceil_div(k0, end_y as u128)?;
            net = to_u64(end_x.saturating_sub(x as u128))?;
            xnt_in = to_u64(ceil_div(net as u128 * 10_000, (10_000 - FEE_BPS) as u128)?)?;
            fee = xnt_in - net;
            complete = true;
        }
        let x_new = x.checked_add(net).ok_or(CurveError::MathOverflow)?;
        let y_new = y.checked_sub(out).ok_or(CurveError::MathOverflow)?;
        require!(x_new as u128 * y_new as u128 >= k0, CurveError::MathOverflow);
        Ok(BuyQuote { xnt_in, fee, net, out, x: x_new, y: y_new, complete })
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct SellQuote {
        pub gross: u64,
        pub fee: u64,
        pub out: u64,
        pub x: u64,
        pub y: u64,
    }

    pub fn sell(x: u64, y: u64, k0: u128, tokens_in: u64) -> Result<SellQuote> {
        let y_new = y.checked_add(tokens_in).ok_or(CurveError::MathOverflow)?;
        let x1 = to_u64(ceil_div(k0, y_new as u128)?)?;
        let gross = x.checked_sub(x1).ok_or(CurveError::MathOverflow)?;
        let fee = ceil_div(gross as u128 * FEE_BPS as u128, 10_000)? as u64;
        let out = gross - fee;
        require!(x1 as u128 * y_new as u128 >= k0, CurveError::MathOverflow);
        Ok(SellQuote { gross, fee, out, x: x1, y: y_new })
    }
}

// ---------- State ----------

#[account]
#[derive(InitSpace)]
pub struct Curve {
    pub mint: Pubkey,
    pub creator: Pubkey,
    /// S, base units.
    pub supply: u64,
    /// T = S * CURVE_BPS / 10000.
    pub curve_tokens: u64,
    /// S - T, minted to auth and deposited into XDEX.
    pub pool_tokens_gross: u64,
    /// What the XDEX vault receives after the transfer fee.
    pub pool_tokens_net: u64,
    /// Lamports that go into the pool at graduation: the creator's pick from
    /// TARGETS_XNT_WHOLE (20 XNT on curves made before targets were selectable).
    pub target_xnt: u64,
    /// Current x (starts at x0).
    pub virtual_xnt: u64,
    /// Current y (starts at y0).
    pub virtual_tokens: u64,
    pub tokens_sold: u64,
    /// Net XNT in the curve (= virtual_xnt - x0).
    pub raised_xnt: u64,
    pub created_at: i64,
    /// 0 Trading, 1 Complete, 2 PoolCreated, 3 Graduated, 4 Finished.
    pub status: u8,
    /// Open (undelivered) positions.
    pub positions: u32,
    pub delivered: u64,
    pub pool: Pubkey,
    pub lock_nft: Pubkey,
    pub tax_bps: u16,
    pub bump: u8,
    pub auth_bump: u8,
}

impl Curve {
    /// k0 = x0 * y0, with x0 = virtual_xnt - raised_xnt and y0 = virtual_tokens + tokens_sold.
    pub fn k0(&self) -> Result<u128> {
        let x0 = self.virtual_xnt.checked_sub(self.raised_xnt).ok_or(CurveError::MathOverflow)?;
        let y0 = self.virtual_tokens.checked_add(self.tokens_sold).ok_or(CurveError::MathOverflow)?;
        Ok(x0 as u128 * y0 as u128)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub curve: Pubkey,
    pub owner: Pubkey,
    /// Tokens owed, base units.
    pub balance: u64,
    /// Lamports paid on the first buy for the owner's token account.
    pub deposit: u64,
    pub bump: u8,
}

// ---------- Accounts ----------

#[derive(Accounts)]
pub struct CreateCurve<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: validated in check_curve_mint.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    #[account(init, payer = creator, space = 8 + Curve::INIT_SPACE, seeds = [b"curve", mint.key().as_ref()], bump)]
    pub curve: Box<Account<'info, Curve>>,
    #[account(mut, seeds = [b"auth", mint.key().as_ref()], bump)]
    pub auth: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, seeds = [b"curve", curve.mint.as_ref()], bump = curve.bump)]
    pub curve: Box<Account<'info, Curve>>,
    #[account(mut, seeds = [b"auth", curve.mint.as_ref()], bump = curve.auth_bump)]
    pub auth: SystemAccount<'info>,
    #[account(
        init_if_needed, payer = buyer, space = 8 + Position::INIT_SPACE,
        seeds = [b"pos", curve.key().as_ref(), buyer.key().as_ref()], bump,
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: the fixed fee receiver.
    #[account(mut, address = FEE_RECEIVER @ CurveError::WrongAccount)]
    pub fee_receiver: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut, seeds = [b"curve", curve.mint.as_ref()], bump = curve.bump)]
    pub curve: Box<Account<'info, Curve>>,
    #[account(mut, seeds = [b"auth", curve.mint.as_ref()], bump = curve.auth_bump)]
    pub auth: SystemAccount<'info>,
    #[account(
        mut, seeds = [b"pos", curve.key().as_ref(), seller.key().as_ref()], bump = position.bump,
        constraint = position.owner == seller.key() @ CurveError::WrongAccount,
        constraint = position.curve == curve.key() @ CurveError::WrongAccount,
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: the fixed fee receiver.
    #[account(mut, address = FEE_RECEIVER @ CurveError::WrongAccount)]
    pub fee_receiver: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GraduatePool<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"curve", curve.mint.as_ref()], bump = curve.bump)]
    pub curve: Box<Account<'info, Curve>>,
    #[account(mut, seeds = [b"auth", curve.mint.as_ref()], bump = curve.auth_bump)]
    pub auth: SystemAccount<'info>,
    /// CHECK: the curve's mint.
    #[account(mut, address = curve.mint @ CurveError::WrongAccount)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: ATA(auth, mint, Token-2022), created here.
    #[account(mut, address = ata(&auth.key(), &curve.mint, &token_2022::ID) @ CurveError::WrongAccount)]
    pub auth_token: UncheckedAccount<'info>,
    /// CHECK: ATA(auth, NATIVE_MINT, SPL Token), created here.
    #[account(mut, address = ata(&auth.key(), &native_mint::ID, &token::ID) @ CurveError::WrongAccount)]
    pub auth_wxnt: UncheckedAccount<'info>,
    /// CHECK: ATA(auth, lp_mint, SPL Token), created by XDEX.
    #[account(mut, address = ata(&auth.key(), &lp_mint.key(), &token::ID) @ CurveError::WrongAccount)]
    pub auth_lp: UncheckedAccount<'info>,
    /// CHECK: the XDEX program this build targets.
    #[account(address = XDEX_PROGRAM_ID @ CurveError::WrongAccount)]
    pub xdex_program: UncheckedAccount<'info>,
    /// CHECK: the XDEX fee tier this build targets.
    #[account(address = XDEX_AMM_CONFIG @ CurveError::WrongAccount)]
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: XDEX vault/LP authority PDA; XDEX verifies it.
    pub xdex_authority: UncheckedAccount<'info>,
    /// CHECK: PDA(["pool", amm_config, mint0, mint1], XDEX), checked in the handler.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: XDEX PDA, verified (and created) by XDEX.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: XDEX PDA, verified (and created) by XDEX.
    #[account(mut)]
    pub vault0: UncheckedAccount<'info>,
    /// CHECK: XDEX PDA, verified (and created) by XDEX.
    #[account(mut)]
    pub vault1: UncheckedAccount<'info>,
    /// CHECK: XDEX's pool-creation fee receiver for this build.
    #[account(mut, address = XDEX_CREATE_POOL_FEE @ CurveError::WrongAccount)]
    pub create_pool_fee: UncheckedAccount<'info>,
    /// CHECK: XDEX PDA, verified (and created) by XDEX.
    #[account(mut)]
    pub observation: UncheckedAccount<'info>,
    /// CHECK: wrapped XNT mint.
    #[account(address = native_mint::ID @ CurveError::WrongAccount)]
    pub native_mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct GraduateLock<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"curve", curve.mint.as_ref()], bump = curve.bump)]
    pub curve: Box<Account<'info, Curve>>,
    #[account(mut, seeds = [b"auth", curve.mint.as_ref()], bump = curve.auth_bump)]
    pub auth: SystemAccount<'info>,
    /// CHECK: the curve's creator (receives the lock NFT).
    #[account(mut, address = curve.creator @ CurveError::WrongAccount)]
    pub creator: UncheckedAccount<'info>,
    /// CHECK: PDA(["nft", curve]); created here as the lock NFT mint.
    #[account(mut, seeds = [b"nft", curve.key().as_ref()], bump)]
    pub nft_mint: UncheckedAccount<'info>,
    /// CHECK: ATA(auth, nft_mint, Token-2022), created here.
    #[account(mut, address = ata(&auth.key(), &nft_mint.key(), &token_2022::ID) @ CurveError::WrongAccount)]
    pub auth_nft: UncheckedAccount<'info>,
    /// CHECK: ATA(creator, nft_mint, Token-2022), created here.
    #[account(mut, address = ata(&curve.creator, &nft_mint.key(), &token_2022::ID) @ CurveError::WrongAccount)]
    pub creator_nft: UncheckedAccount<'info>,
    /// CHECK: the curve's pool; lp_locker checks its layout, LP mint and vaults.
    #[account(address = curve.pool @ CurveError::WrongAccount)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: checked by lp_locker against the pool.
    pub token_0_vault: UncheckedAccount<'info>,
    /// CHECK: checked by lp_locker against the pool.
    pub token_1_vault: UncheckedAccount<'info>,
    /// CHECK: checked by lp_locker against the pool.
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: ATA(auth, lp_mint, SPL Token).
    #[account(mut, address = ata(&auth.key(), &lp_mint.key(), &token::ID) @ CurveError::WrongAccount)]
    pub auth_lp: UncheckedAccount<'info>,
    /// CHECK: lp_locker PDA(["lock", nft_mint]); lp_locker creates and verifies it.
    #[account(mut)]
    pub lock: UncheckedAccount<'info>,
    /// CHECK: lp_locker PDA(["vault", lock]); lp_locker creates and verifies it.
    #[account(mut)]
    pub lock_vault: UncheckedAccount<'info>,
    /// CHECK: the lp_locker program.
    #[account(address = LOCKER_PROGRAM_ID @ CurveError::WrongAccount)]
    pub locker_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deliver<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"curve", curve.mint.as_ref()], bump = curve.bump)]
    pub curve: Box<Account<'info, Curve>>,
    #[account(mut, seeds = [b"auth", curve.mint.as_ref()], bump = curve.auth_bump)]
    pub auth: SystemAccount<'info>,
    #[account(
        mut, close = owner,
        seeds = [b"pos", curve.key().as_ref(), position.owner.as_ref()], bump = position.bump,
        constraint = position.curve == curve.key() @ CurveError::WrongAccount,
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: the position's owner.
    #[account(mut, address = position.owner @ CurveError::WrongAccount)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: ATA(owner, mint, Token-2022), created here if needed.
    #[account(mut, address = ata(&position.owner, &curve.mint, &token_2022::ID) @ CurveError::WrongAccount)]
    pub owner_token: UncheckedAccount<'info>,
    /// CHECK: the curve's mint.
    #[account(mut, address = curve.mint @ CurveError::WrongAccount)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the curve's creator (receives what is left at the end).
    #[account(mut, address = curve.creator @ CurveError::WrongAccount)]
    pub creator: UncheckedAccount<'info>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ---------- Events ----------

#[event]
pub struct CurveCreated {
    pub curve: Pubkey,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub supply: u64,
    pub x0: u64,
    pub y0: u64,
    pub created_at: i64,
}

#[event]
pub struct Trade {
    pub curve: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    /// Gross XNT paid (buy) or received before the fee (sell).
    pub xnt: u64,
    pub fee: u64,
    pub tokens: u64,
    pub virtual_xnt: u64,
    pub virtual_tokens: u64,
    pub tokens_sold: u64,
    pub raised_xnt: u64,
    pub ts: i64,
}

#[event]
pub struct Graduated {
    pub curve: Pubkey,
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub lock_nft: Pubkey,
    pub raised_xnt: u64,
}

#[event]
pub struct Delivered {
    pub curve: Pubkey,
    pub owner: Pubkey,
    pub tokens: u64,
}

#[error_code]
pub enum CurveError {
    #[msg("Mint must be a fresh 9-decimal Token-2022 mint: supply 0, mint authority = curve auth, no freeze authority, only transfer-fee and metadata extensions, metadata update authority = creator")]
    BadMint,
    #[msg("Supply must be between 1,000 and 10,000,000,000 whole tokens")]
    BadSupply,
    #[msg("Transfer fee must be 100-1000 bps with no fee-config authority")]
    BadTax,
    #[msg("The curve is not trading")]
    NotTrading,
    #[msg("The creator cannot buy on their own curve")]
    CreatorCannotBuy,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Price moved beyond the slippage limit")]
    Slippage,
    #[msg("Buy too large during the anti-snipe window")]
    TooBigEarly,
    #[msg("Position balance too low")]
    InsufficientBalance,
    #[msg("Wrong curve status for this instruction")]
    WrongStatus,
    #[msg("Wrong account")]
    WrongAccount,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Curve auth would not cover the open positions' deposits; top it up and retry")]
    InsufficientReserve,
    #[msg("Graduation target must be 500, 1,000, 3,000, 5,000 or 10,000 XNT")]
    BadTarget,
}

#[cfg(test)]
mod tests {
    use super::math::{buy, ceil_div, sell, setup, Setup};
    use super::{
        pool_amounts, target_lamports, Curve, CurveError, FEE_BPS, MAX_SUPPLY_WHOLE, MIN_SUPPLY_WHOLE, SNIPE_MAX_BPS,
        STATUS_COMPLETE, STATUS_TRADING, TARGETS_XNT_WHOLE,
    };
    use anchor_lang::prelude::*;
    use anchor_lang::{AccountDeserialize, AccountSerialize};

    const XNT: u64 = 1_000_000_000;
    /// The fixed target of curves created before targets were selectable.
    const OLD_TARGET: u64 = 20 * XNT;

    /// Every allowed target in lamports, plus the old 20 XNT (still stored in older curves).
    fn targets() -> Vec<u64> {
        let mut t: Vec<u64> = TARGETS_XNT_WHOLE.iter().map(|w| target_lamports(*w).unwrap()).collect();
        t.push(OLD_TARGET);
        t
    }

    /// Flooring `a` in setup leaves the full curve up to R * T / a^2 lamports short of R (143
    /// at 10,000 XNT with the minimum supply, 3 at 20 XNT); auth's GRADUATION_DEPOSIT covers it.
    fn max_short(r: u64) -> u128 {
        10 + r as u128 / 50_000_000_000
    }

    fn fee_fn(bps: u64) -> impl Fn(u64) -> Option<u64> {
        move |a| Some(((a as u128 * bps as u128 + 9_999) / 10_000) as u64)
    }

    fn k0(s: &Setup) -> u128 {
        s.x0 as u128 * s.y0 as u128
    }

    fn code(e: anchor_lang::error::Error) -> u32 {
        match e {
            anchor_lang::error::Error::AnchorError(a) => a.error_code_number,
            other => panic!("not an Anchor error: {other:?}"),
        }
    }

    #[test]
    fn targets_are_checked() {
        for w in TARGETS_XNT_WHOLE {
            assert_eq!(target_lamports(w).unwrap(), w * XNT);
        }
        #[cfg(feature = "testnet")]
        let (allowed, refused): (&[u64], &[u64]) = (&[10, 20, 500, 1_000, 3_000, 5_000, 10_000], &[0, 9, 11, 19, 21, 499, 501, 20_000, u64::MAX]);
        #[cfg(not(feature = "testnet"))]
        let (allowed, refused): (&[u64], &[u64]) = (&[500, 1_000, 3_000, 5_000, 10_000], &[0, 10, 20, 499, 501, 20_000, u64::MAX]);
        assert_eq!(&TARGETS_XNT_WHOLE[..], allowed);
        for &w in refused {
            assert_eq!(code(target_lamports(w).unwrap_err()), u32::from(CurveError::BadTarget), "target {w}");
        }
        // Appended last: every earlier error keeps its code.
        assert_eq!(u32::from(CurveError::InsufficientReserve), 6012);
        assert_eq!(u32::from(CurveError::BadTarget), 6013);
    }

    #[test]
    fn setup_ends_at_target_and_pool_price() {
        for r in targets() {
            for supply_whole in [MIN_SUPPLY_WHOLE, 1_000_000, 1_000_000_000, 7_777_777_777, MAX_SUPPLY_WHOLE] {
                for bps in [100u64, 500, 1000] {
                    let s = setup(supply_whole * XNT, r, fee_fn(bps)).unwrap();
                    assert_eq!(s.t + s.pg, supply_whole * XNT);
                    // Buying everything raises (at most) R, short by only a few lamports.
                    let end_x = ceil_div(k0(&s), s.a as u128).unwrap();
                    let raised = end_x - s.x0 as u128;
                    assert!(raised <= r as u128 && r as u128 - raised <= max_short(r), "raised {raised} of {r} for {supply_whole}/{bps}");
                    // The end of the curve fits a u64 (it becomes virtual_xnt).
                    assert!(end_x <= u64::MAX as u128);
                    // Final curve price == pool opening price R / Pn (relative error < 1e-9).
                    let lhs = end_x * s.pn as u128; // x_end / a  vs  R / Pn
                    let rhs = r as u128 * s.a as u128;
                    let diff = lhs.abs_diff(rhs);
                    assert!(diff * 1_000_000_000 < rhs, "price mismatch {r}/{supply_whole}/{bps}");
                }
            }
        }
    }

    #[test]
    fn buys_and_sells_keep_k_and_favour_the_curve() {
        for r in targets() {
            let s = setup(1_000_000_000 * XNT, r, fee_fn(500)).unwrap();
            let k = k0(&s);
            let (mut x, mut y, mut sold, mut raised) = (s.x0, s.y0, 0u64, 0u64);
            let mut seed = 12345u64;
            let mut rnd = || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed };
            let mut held: u64 = 0;
            // Buys of up to R/400 each: 2,000 trades stay short of completion.
            for i in 0..2_000 {
                if i % 3 == 2 && held > 0 {
                    let t_in = rnd() % held + 1;
                    let q = sell(x, y, k, t_in).unwrap();
                    assert!(q.x as u128 * q.y as u128 >= k);
                    assert_eq!(q.fee + q.out, q.gross);
                    x = q.x; y = q.y; sold -= t_in; held -= t_in; raised -= q.gross;
                } else {
                    let q = buy(x, y, k, sold, s.t, rnd() % (r / 400) + 1).unwrap();
                    assert!(q.x as u128 * q.y as u128 >= k);
                    assert!(q.fee * 10_000 >= q.xnt_in * FEE_BPS);
                    x = q.x; y = q.y; sold += q.out; held += q.out; raised += q.net;
                    assert!(!q.complete);
                }
                assert_eq!(x - s.x0, raised);
                assert_eq!(y + sold, s.y0);
            }
            // Round trip: a buy then selling it all back never returns more than was paid.
            let b = buy(x, y, k, sold, s.t, r / 20).unwrap();
            let sq = sell(b.x, b.y, k, b.out).unwrap();
            assert!(sq.out < b.xnt_in && sq.gross <= b.net);
        }
    }

    #[test]
    fn last_buy_fills_exactly_to_t() {
        for r in targets() {
            for supply_whole in [MIN_SUPPLY_WHOLE, 1_000_000, MAX_SUPPLY_WHOLE] {
                let s = setup(supply_whole * XNT, r, fee_fn(1000)).unwrap();
                let k = k0(&s);
                let q = buy(s.x0, s.y0, k, 0, s.t, 2 * r).unwrap();
                assert!(q.complete);
                assert_eq!(q.out, s.t);
                assert_eq!(q.y, s.a);
                assert!(q.xnt_in < 2 * r);
                assert!(q.net <= r && (r - q.net) as u128 <= max_short(r), "net {} of {r}", q.net);
                assert!(q.fee * 10_000 >= q.xnt_in * FEE_BPS);
                // Offering exactly the quoted amount completes too, and charges the same.
                let q2 = buy(s.x0, s.y0, k, 0, s.t, q.xnt_in).unwrap();
                assert!(q2.complete);
                assert_eq!(q2.xnt_in, q.xnt_in);
                // Any offer at all completes without overflow.
                let q3 = buy(s.x0, s.y0, k, 0, s.t, u64::MAX).unwrap();
                assert_eq!((q3.out, q3.xnt_in), (q.out, q.xnt_in));
            }
        }
    }

    #[test]
    fn many_buys_to_completion_for_every_target_and_supply_bound() {
        for r in targets() {
            for supply_whole in [MIN_SUPPLY_WHOLE, MAX_SUPPLY_WHOLE] {
                let s = setup(supply_whole * XNT, r, fee_fn(500)).unwrap();
                let k = k0(&s);
                let (mut x, mut y, mut sold) = (s.x0, s.y0, 0u64);
                let mut n = 0;
                loop {
                    // ~50 buys; the one that reaches T completes the curve.
                    let q = buy(x, y, k, sold, s.t, r / 50 + 7).unwrap();
                    x = q.x; y = q.y; sold += q.out; n += 1;
                    if q.complete { break; }
                }
                assert_eq!(sold, s.t);
                assert!(n > 40 && n < 60, "{n} buys");
                let raised = x - s.x0;
                assert!(raised <= r && (r - raised) as u128 <= max_short(r));
                // The pool opens at R / Pn: the curve's last price x / y matches it.
                let (lhs, rhs) = (x as u128 * s.pn as u128, r as u128 * y as u128);
                assert!(lhs.abs_diff(rhs) * 1_000_000_000 < rhs);
                // The anti-snipe cap is on tokens (1% of supply), the same for every target.
                assert_eq!((s.t + s.pg) as u128 * SNIPE_MAX_BPS as u128 / 10_000, (supply_whole * XNT / 100) as u128);
            }
        }
    }

    #[test]
    fn supply_bounds_do_not_overflow() {
        for r in targets() {
            assert!(setup(MAX_SUPPLY_WHOLE * XNT, r, fee_fn(100)).is_ok());
            assert!(setup(MAX_SUPPLY_WHOLE * XNT, r, fee_fn(1000)).is_ok());
            assert!(setup(MIN_SUPPLY_WHOLE * XNT, r, fee_fn(100)).is_ok());
            assert!(setup(MIN_SUPPLY_WHOLE * XNT, r, fee_fn(1000)).is_ok());
        }
    }

    /// A curve account as the old program wrote it (fixed 20 XNT target), read back by this
    /// one: same layout, and it graduates with the target stored in the account.
    #[test]
    fn old_20_xnt_curve_graduates_with_its_stored_target() {
        let supply = 1_000_000_000 * XNT;
        let s = setup(supply, OLD_TARGET, fee_fn(500)).unwrap();
        let old = Curve {
            mint: Pubkey::new_unique(), creator: Pubkey::new_unique(), supply, curve_tokens: s.t,
            pool_tokens_gross: s.pg, pool_tokens_net: s.pn, target_xnt: OLD_TARGET, virtual_xnt: s.x0, virtual_tokens: s.y0,
            tokens_sold: 0, raised_xnt: 0, created_at: 1_700_000_000, status: STATUS_TRADING, positions: 0, delivered: 0,
            pool: Pubkey::default(), lock_nft: Pubkey::default(), tax_bps: 500, bump: 254, auth_bump: 253,
        };
        let mut data = Vec::new();
        old.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), 8 + Curve::INIT_SPACE);
        assert_eq!(Curve::INIT_SPACE, 225, "the Curve layout must not change");
        assert_eq!(u64::from_le_bytes(data[104..112].try_into().unwrap()), OLD_TARGET, "target_xnt at offset 104");

        let mut c = Curve::try_deserialize(&mut &data[..]).unwrap();
        // Part bought before the upgrade, the rest after, as the buy handler applies it.
        for xnt_in in [5 * XNT, 4 * XNT, 100 * XNT] {
            let q = buy(c.virtual_xnt, c.virtual_tokens, c.k0().unwrap(), c.tokens_sold, c.curve_tokens, xnt_in).unwrap();
            c.virtual_xnt = q.x;
            c.virtual_tokens = q.y;
            c.tokens_sold += q.out;
            c.raised_xnt += q.net;
            if q.complete { c.status = STATUS_COMPLETE; }
        }
        assert_eq!(c.status, STATUS_COMPLETE);
        assert_eq!(c.tokens_sold, c.curve_tokens);
        assert!(c.raised_xnt <= OLD_TARGET && OLD_TARGET - c.raised_xnt < 10, "raised {}", c.raised_xnt);
        // graduate_pool deposits the stored 20 XNT (not any of the new targets) and the pool's tokens.
        assert_eq!(pool_amounts(&c), (s.pg, OLD_TARGET));
        let (lhs, rhs) = (c.virtual_xnt as u128 * c.pool_tokens_net as u128, OLD_TARGET as u128 * c.virtual_tokens as u128);
        assert!(lhs.abs_diff(rhs) * 1_000_000_000 < rhs, "old curve ends at its pool's opening price");
    }
}
