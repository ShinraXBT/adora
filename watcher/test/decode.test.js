import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { base58, base58Decode, decodeProgramData, eventsFromLogs, hasSocialClaim, socialClaimsFromTransaction } from '../src/decode.js';

// Minimal Borsh writer driven by field lists copied from the official IDLs
// (pump-fun/pump-public-docs, idl/pump.json and idl/pump_amm.json).
function encode(eventName, fields, values) {
  const parts = [createHash('sha256').update(`event:${eventName}`).digest().subarray(0, 8)];
  for (const [name, type] of fields) {
    const v = values[name];
    if (type === 'pubkey') parts.push(v ?? Buffer.alloc(32, 7));
    else if (type === 'u64' || type === 'i64') {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(BigInt(v ?? 1));
      parts.push(b);
    } else if (type === 'i128') parts.push(Buffer.alloc(16, 1));
    else if (type === 'bool') parts.push(Buffer.from([v ? 1 : 0]));
    else if (type === 'u8') parts.push(Buffer.from([v ?? 0]));
    else if (type === 'string') {
      const s = Buffer.from(v ?? 'x', 'utf8');
      const len = Buffer.alloc(4);
      len.writeUInt32LE(s.length);
      parts.push(len, s);
    } else if (type === 'vec') parts.push(Buffer.alloc(4));
    else throw new Error(type);
  }
  return Buffer.concat(parts).toString('base64');
}

const CREATE_EVENT = [
  ['name', 'string'], ['symbol', 'string'], ['uri', 'string'], ['mint', 'pubkey'], ['bonding_curve', 'pubkey'],
  ['user', 'pubkey'], ['creator', 'pubkey'], ['timestamp', 'i64'], ['virtual_token_reserves', 'u64'],
  ['virtual_sol_reserves', 'u64'], ['real_token_reserves', 'u64'], ['token_total_supply', 'u64'],
  ['token_program', 'pubkey'], ['is_mayhem_mode', 'bool'], ['is_cashback_enabled', 'bool'], ['quote_mint', 'pubkey'],
  ['virtual_quote_reserves', 'u64'], ['creator_fee_bps', 'u64'], ['is_holder_reward', 'bool'], ['depth', 'u8'],
];

const TRADE_EVENT = [
  ['mint', 'pubkey'], ['sol_amount', 'u64'], ['token_amount', 'u64'], ['is_buy', 'bool'], ['user', 'pubkey'],
  ['timestamp', 'i64'], ['virtual_sol_reserves', 'u64'], ['virtual_token_reserves', 'u64'], ['real_sol_reserves', 'u64'],
  ['real_token_reserves', 'u64'], ['fee_recipient', 'pubkey'], ['fee_basis_points', 'u64'], ['fee', 'u64'],
  ['creator', 'pubkey'], ['creator_fee_basis_points', 'u64'], ['creator_fee', 'u64'], ['track_volume', 'bool'],
  ['total_unclaimed_tokens', 'u64'], ['total_claimed_tokens', 'u64'], ['current_sol_volume', 'u64'],
  ['last_update_timestamp', 'i64'], ['ix_name', 'string'], ['mayhem_mode', 'bool'], ['cashback_fee_basis_points', 'u64'],
  ['cashback', 'u64'], ['buyback_fee_basis_points', 'u64'], ['buyback_fee', 'u64'], ['shareholders', 'vec'],
  ['quote_mint', 'pubkey'], ['quote_amount', 'u64'], ['virtual_quote_reserves', 'u64'], ['real_quote_reserves', 'u64'],
  ['holder_rewards_bps', 'u64'], ['holder_rewards', 'u64'], ['creator_fee_unclaimed', 'u64'],
];

const AMM_HEAD = ['timestamp', 'base_amount_out', 'max_quote_amount_in', 'user_base_token_reserves',
  'user_quote_token_reserves', 'pool_base_token_reserves', 'pool_quote_token_reserves', 'quote_amount_in',
  'lp_fee_basis_points', 'lp_fee', 'protocol_fee_basis_points', 'protocol_fee', 'quote_amount_in_with_lp_fee',
  'user_quote_amount_in'].map(n => [n, 'u64']);
const AMM_BUY_EVENT = [
  ...AMM_HEAD, ['pool', 'pubkey'], ['user', 'pubkey'], ['user_base_token_account', 'pubkey'],
  ['user_quote_token_account', 'pubkey'], ['protocol_fee_recipient', 'pubkey'],
  ['protocol_fee_recipient_token_account', 'pubkey'], ['coin_creator', 'pubkey'], ['coin_creator_fee_basis_points', 'u64'],
  ['coin_creator_fee', 'u64'], ['track_volume', 'bool'], ['virtual_quote_reserves', 'i128'],
];

test('base58 matches known vectors', () => {
  assert.equal(base58(Buffer.alloc(32)), '11111111111111111111111111111111');
  assert.equal(base58(Buffer.from('Hello World!')), '2NEpo7TZRRrLZSi2U');
  assert.equal(base58(Buffer.from([0, 0, 0x28, 0x7f, 0xb4, 0xcd])), '11233QC4');
});

test('decodes a pump CreateEvent', () => {
  const [mint, user, creator] = [randomBytes(32), randomBytes(32), randomBytes(32)];
  const ev = decodeProgramData(encode('CreateEvent', CREATE_EVENT, { name: 'Naseem Coin', symbol: 'NSM', uri: 'https://ipfs.io/x', mint, user, creator }));
  assert.deepEqual(ev, { type: 'create', name: 'Naseem Coin', symbol: 'NSM', mint: base58(mint), user: base58(user), creator: base58(creator) });
});

test('decodes a pump TradeEvent (buy and sell)', () => {
  const [mint, user, creator] = [randomBytes(32), randomBytes(32), randomBytes(32)];
  const buy = decodeProgramData(encode('TradeEvent', TRADE_EVENT, { mint, user, creator, sol_amount: 1_500_000_000, is_buy: true }));
  assert.deepEqual(buy, { type: 'buy', mint: base58(mint), sol: 1.5, user: base58(user), creator: base58(creator) });
  const sell = decodeProgramData(encode('TradeEvent', TRADE_EVENT, { mint, user, creator, is_buy: false }));
  assert.equal(sell.type, 'sell');
});

test('decodes PumpSwap BuyEvent and SellEvent', () => {
  const [pool, user, creator] = [randomBytes(32), randomBytes(32), randomBytes(32)];
  const values = { pool, user, coin_creator: creator };
  const buy = decodeProgramData(encode('BuyEvent', AMM_BUY_EVENT, values));
  assert.deepEqual(buy, { type: 'amm-buy', pool: base58(pool), user: base58(user), creator: base58(creator) });
  // SellEvent has the same 14-field head and the same account order up to coin_creator.
  assert.equal(decodeProgramData(encode('SellEvent', AMM_BUY_EVENT, values)).type, 'amm-sell');
});

test('ignores unknown, truncated and malformed data', () => {
  assert.equal(decodeProgramData(Buffer.alloc(40).toString('base64')), null);
  const full = Buffer.from(encode('TradeEvent', TRADE_EVENT, {}), 'base64');
  assert.equal(decodeProgramData(full.subarray(0, 60).toString('base64')), null);
  assert.equal(decodeProgramData('%%%'), null);
});

test('extracts events from transaction logs', () => {
  const user = randomBytes(32);
  const logs = [
    'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
    'Program log: Instruction: Buy',
    `Program data: ${encode('TradeEvent', TRADE_EVENT, { user, is_buy: true })}`,
    'Program data: AAAA',
    'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success',
  ];
  const events = eventsFromLogs(logs);
  assert.equal(events.length, 1);
  assert.equal(events[0].user, base58(user));
});

const SOCIAL_FEE_PDA_CLAIMED = [
  ['timestamp', 'i64'], ['user_id', 'string'], ['platform', 'u8'], ['social_fee_pda', 'pubkey'], ['recipient', 'pubkey'],
  ['social_claim_authority', 'pubkey'], ['amount_claimed', 'u64'], ['claimable_before', 'u64'], ['lifetime_claimed', 'u64'],
  ['recipient_balance_before', 'u64'], ['recipient_balance_after', 'u64'], ['quote_mint', 'pubkey'],
  ['lifetime_stable_claimed', 'u64'],
];

test('base58 decodes what it encodes', () => {
  for (const bytes of [Buffer.alloc(32), randomBytes(32), Buffer.from([0, 0, 5, 255])]) {
    assert.deepEqual(base58Decode(base58(bytes)), bytes);
  }
});

test('decodes a SocialFeePdaClaimed event from the logs', () => {
  const recipient = randomBytes(32);
  const b64 = encode('SocialFeePdaClaimed', SOCIAL_FEE_PDA_CLAIMED, { user_id: '44196397', platform: 1, recipient });
  assert.deepEqual(eventsFromLogs([`Program data: ${b64}`]), [
    { type: 'social-claim', userId: '44196397', platform: 1, recipient: base58(recipient) },
  ]);
  assert.equal(hasSocialClaim(['Program log: Instruction: ClaimSocialFeePdaV2']), true);
  assert.equal(hasSocialClaim(['Program log: Instruction: Buy']), false);
});

test('finds fee claims in the event CPI or the claim instruction of a transaction', () => {
  const recipient = randomBytes(32);
  const event = Buffer.from(encode('SocialFeePdaClaimed', SOCIAL_FEE_PDA_CLAIMED, { user_id: '123', platform: 1, recipient }), 'base64');
  const cpi = Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), event]);
  const viaCpi = socialClaimsFromTransaction({
    transaction: { message: { accountKeys: [], instructions: [] } },
    meta: { logMessages: [], innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 0, accounts: [], data: base58(cpi) }] }] },
  });
  assert.deepEqual(viaCpi, [{ type: 'social-claim', userId: '123', platform: 1, recipient: base58(recipient) }]);

  // claim_social_fee_pda(user_id: string, platform: u8); accounts[0] is the recipient
  const id = Buffer.from('987654321');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(id.length);
  const ix = Buffer.concat([Buffer.from('e115fb85a11ec7e2', 'hex'), len, id, Buffer.from([1])]);
  const keys = ['Payer1111111111111111111111111111111111111', base58(recipient)];
  const viaIx = socialClaimsFromTransaction({
    transaction: { message: { accountKeys: keys, instructions: [{ programIdIndex: 0, accounts: [1, 0], data: base58(ix) }] } },
    meta: { logMessages: [], innerInstructions: [] },
  });
  assert.deepEqual(viaIx, [{ type: 'social-claim', userId: '987654321', platform: 1, recipient: base58(recipient) }]);
});
