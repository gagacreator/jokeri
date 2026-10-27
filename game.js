'use strict';

// Joker (ჯოკერი) rules engine. Pure state transitions, no I/O.
// Seats are 0..3 clockwise. Cards: {id, s, r}; s is S/C/D/H or J (joker).

const SUITS = ['S', 'C', 'D', 'H'];

// Deal schedule: pulka 1 = 1..8 cards, pulka 2 = 4x9, pulka 3 = 8..1, pulka 4 = 4x9
const DEALS = [];
for (let c = 1; c <= 8; c++) DEALS.push({ pulka: 0, cards: c });
for (let i = 0; i < 4; i++) DEALS.push({ pulka: 1, cards: 9 });
for (let c = 8; c >= 1; c--) DEALS.push({ pulka: 2, cards: c });
for (let i = 0; i < 4; i++) DEALS.push({ pulka: 3, cards: 9 });

function buildDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (let r = 6; r <= 14; r++) {
      if (r === 6 && (s === 'S' || s === 'C')) continue; // black sixes are removed
      deck.push({ id: s + r, s, r });
    }
  }
  deck.push({ id: 'J1', s: 'J', r: 15 }, { id: 'J2', s: 'J', r: 15 });
  return deck;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function fail(msg) { throw new Error(msg); }

function newGame(names) {
  const g = {
    names,
    dealIdx: -1,
    history: [],
    totals: [0, 0, 0, 0],
    phase: 'bidding',
  };
  startDeal(g);
  return g;
}

function startDeal(g) {
  g.dealIdx++;
  const spec = DEALS[g.dealIdx];
  g.pulka = spec.pulka;
  g.cards = spec.cards;
  g.dealer = g.dealIdx % 4;
  const deck = shuffle(buildDeck());
  g.hands = [0, 1, 2, 3].map(i => deck.slice(i * g.cards, (i + 1) * g.cards));
  g.bids = [null, null, null, null];
  g.tricksWon = [0, 0, 0, 0];
  g.trump = null; // S/C/D/H or 'N' (no trump)
  g.trumpChooser = null;
  g.trick = [];
  g.lastTrick = null;
  g.trickWinner = null;
  g.dealSummary = null;
  g.leader = (g.dealer + 1) % 4;
  g.turn = g.leader;
  g.phase = 'bidding';
}

function bidOrder(g) {
  return [1, 2, 3, 4].map(i => (g.dealer + i) % 4);
}

function forbiddenBid(g, seat) {
  if (g.phase !== 'bidding' || seat !== g.dealer) return null;
  const sum = g.bids.reduce((a, b) => a + (b === null ? 0 : b), 0);
  const f = g.cards - sum;
  return f >= 0 && f <= g.cards ? f : null;
}

function bid(g, seat, n) {
  if (g.phase !== 'bidding') fail('არასწორი ფაზა');
  if (g.turn !== seat) fail('ახლა შენი რიგი არ არის');
  if (!Number.isInteger(n) || n < 0 || n > g.cards) fail('არასწორი დაკვეთა');
  if (forbiddenBid(g, seat) === n) fail('დილერს ეს დაკვეთა ეკრძალება');
  g.bids[seat] = n;
  const order = bidOrder(g);
  const idx = order.indexOf(seat);
  if (idx < 3) {
    g.turn = order[idx + 1];
    return;
  }
  const max = Math.max(...g.bids);
  if (max === 0) {
    g.trump = 'N';
    beginPlay(g);
  } else {
    g.trumpChooser = order.find(s => g.bids[s] === max);
    g.turn = g.trumpChooser;
    g.phase = 'trump';
  }
}

function chooseTrump(g, seat, suit) {
  if (g.phase !== 'trump') fail('არასწორი ფაზა');
  if (g.turn !== seat) fail('ახლა შენი რიგი არ არის');
  if (suit !== 'N' && !SUITS.includes(suit)) fail('არასწორი კოზირი');
  g.trump = suit;
  beginPlay(g);
}

function beginPlay(g) {
  g.phase = 'playing';
  g.turn = g.leader;
}

function ledSuit(trick) {
  if (!trick.length) return undefined;
  const first = trick[0];
  if (first.card.s !== 'J') return first.card.s;
  if (first.mode === 'high') return first.suit;
  const next = trick.find(t => t.card.s !== 'J');
  return next ? next.card.s : undefined;
}

function legalPlays(g, seat) {
  if (g.phase !== 'playing' || g.turn !== seat) return [];
  const hand = g.hands[seat];
  const led = ledSuit(g.trick);
  if (!g.trick.length || !led) return hand.map(c => c.id);
  if (hand.some(c => c.s === led)) {
    return hand.filter(c => c.s === led || c.s === 'J').map(c => c.id);
  }
  if (g.trump !== 'N' && hand.some(c => c.s === g.trump)) {
    return hand.filter(c => c.s === g.trump || c.s === 'J').map(c => c.id);
  }
  return hand.map(c => c.id);
}

function play(g, seat, cardId, opts = {}) {
  if (g.phase !== 'playing') fail('არასწორი ფაზა');
  if (g.turn !== seat) fail('ახლა შენი რიგი არ არის');
  const legal = legalPlays(g, seat);
  if (!legal.includes(cardId)) fail('ამ კარტის გათამაშება არ შეიძლება');
  const hand = g.hands[seat];
  const idx = hand.findIndex(c => c.id === cardId);
  const card = hand[idx];
  const entry = { seat, card };
  if (card.s === 'J') {
    const mode = opts.mode === 'low' ? 'low' : 'high';
    entry.mode = mode;
    if (g.trick.length === 0 && mode === 'high') {
      if (!SUITS.includes(opts.suit)) fail('აირჩიე ჯოკერის ნიშანი');
      entry.suit = opts.suit;
    }
  }
  hand.splice(idx, 1);
  g.trick.push(entry);
  if (g.trick.length === 4) {
    g.trickWinner = trickWinner(g.trick, g.trump);
    g.phase = 'trickEnd';
    g.turn = null;
  } else {
    g.turn = (seat + 1) % 4;
  }
}

function trickWinner(trick, trump) {
  const highs = trick.filter(t => t.card.s === 'J' && t.mode === 'high');
  if (highs.length) return highs[highs.length - 1].seat;
  const cards = trick.filter(t => t.card.s !== 'J');
  const best = list => list.reduce((a, b) => (b.card.r > a.card.r ? b : a));
  if (trump && trump !== 'N') {
    const tr = cards.filter(t => t.card.s === trump);
    if (tr.length) return best(tr).seat;
  }
  const led = ledSuit(trick);
  const followers = cards.filter(t => t.card.s === led);
  if (followers.length) return best(followers).seat;
  return trick[0].seat;
}

function scoreFor(bid, taken) {
  if (taken === bid) return bid === 0 ? 50 : 50 + 50 * bid;
  return taken * 10 - (bid > taken ? 50 * (bid - taken) : 0);
}

// Called by the server after the pause that follows a completed trick / deal.
function advance(g) {
  if (g.phase === 'trickEnd') {
    g.tricksWon[g.trickWinner]++;
    g.lastTrick = g.trick;
    g.trick = [];
    g.leader = g.trickWinner;
    g.turn = g.trickWinner;
    if (g.hands.every(h => h.length === 0)) {
      const points = g.bids.map((b, i) => scoreFor(b, g.tricksWon[i]));
      points.forEach((p, i) => { g.totals[i] += p; });
      g.dealSummary = {
        deal: g.dealIdx,
        pulka: g.pulka,
        cards: g.cards,
        dealer: g.dealer,
        trump: g.trump,
        bids: g.bids.slice(),
        taken: g.tricksWon.slice(),
        points,
      };
      g.history.push(g.dealSummary);
      g.phase = 'dealEnd';
      g.turn = null;
    } else {
      g.phase = 'playing';
    }
  } else if (g.phase === 'dealEnd') {
    if (g.dealIdx + 1 >= DEALS.length) {
      g.phase = 'finished';
      g.turn = null;
    } else {
      startDeal(g);
    }
  }
}

function sortHand(hand, trump) {
  const order = { J: 0, S: 1, H: 2, C: 3, D: 4 };
  return hand.slice().sort((a, b) => (order[a.s] - order[b.s]) || (b.r - a.r));
}

// Personalized view: never leaks other players' hands.
function viewFor(g, seat) {
  const mine = seat >= 0 ? sortHand(g.hands[seat]) : [];
  return {
    names: g.names,
    phase: g.phase,
    dealIdx: g.dealIdx,
    totalDeals: DEALS.length,
    pulka: g.pulka,
    cards: g.cards,
    dealer: g.dealer,
    turn: g.turn,
    bids: g.bids,
    trump: g.trump,
    trumpChooser: g.trumpChooser,
    trick: g.trick,
    trickWinner: g.phase === 'trickEnd' ? g.trickWinner : null,
    lastTrick: g.lastTrick,
    tricksWon: g.tricksWon,
    handCounts: g.hands.map(h => h.length),
    hand: mine,
    legal: seat >= 0 ? legalPlays(g, seat) : [],
    forbiddenBid: seat >= 0 && g.turn === seat ? forbiddenBid(g, seat) : null,
    totals: g.totals,
    history: g.history,
    dealSummary: g.phase === 'dealEnd' ? g.dealSummary : null,
  };
}

module.exports = {
  SUITS, DEALS, newGame, bid, chooseTrump, play, advance, legalPlays,
  viewFor, trickWinner, scoreFor, ledSuit, buildDeck,
};
