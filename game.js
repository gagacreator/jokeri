'use strict';

// Joker (ჯოკერი) rules engine, following the rules described at pagat.com/exact/joker.html
// Pure state transitions, no I/O. Seats 0..3 run clockwise.
// Cards: {id, s, r}; s is S/C/D/H or J (joker).

const SUITS = ['S', 'C', 'D', 'H'];

// 24 deals in four pulkas: 1..8 cards, 4x9, 8..1 cards, 4x9
const DEALS = [];
for (let c = 1; c <= 8; c++) DEALS.push({ pulka: 0, cards: c });
for (let i = 0; i < 4; i++) DEALS.push({ pulka: 1, cards: 9 });
for (let c = 8; c >= 1; c--) DEALS.push({ pulka: 2, cards: c });
for (let i = 0; i < 4; i++) DEALS.push({ pulka: 3, cards: 9 });

function buildDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (let r = 6; r <= 14; r++) {
      if (r === 6 && (s === 'S' || s === 'C')) continue; // black sixes are replaced by jokers
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
  // Ace draw: cards are turned up one at a time, clockwise from seat 0;
  // whoever gets the first ace deals first (and therefore bids last).
  const deck = shuffle(buildDeck());
  const seq = [];
  for (let i = 0; ; i++) {
    seq.push({ seat: i % 4, card: deck[i] });
    if (deck[i].s !== 'J' && deck[i].r === 14) break;
  }
  const firstDealer = seq[seq.length - 1].seat;
  return {
    names,
    phase: 'draw',
    draw: { seq, winner: firstDealer },
    firstDealer,
    dealIdx: -1,
    pulka: 0,
    cards: 0,
    dealer: firstDealer,
    history: [],
    bonuses: {},
    cuts: {},
    totals: [0, 0, 0, 0],
    hands: [[], [], [], []],
    bids: [null, null, null, null],
    tricksWon: [0, 0, 0, 0],
    trump: null,
    trumpCard: null,
    trumpChooser: null,
    trick: [],
    lastTrick: null,
    trickWinner: null,
    dealSummary: null,
    leader: (firstDealer + 1) % 4,
    turn: null,
  };
}

function startDeal(g) {
  g.dealIdx++;
  const spec = DEALS[g.dealIdx];
  g.pulka = spec.pulka;
  g.cards = spec.cards;
  g.dealer = (g.firstDealer + g.dealIdx) % 4;
  const deck = shuffle(buildDeck());
  g.hands = [0, 1, 2, 3].map(i => deck.slice(i * g.cards, (i + 1) * g.cards));
  // Pulkas 1 and 3 (1..8 cards): the next card of the stock is turned up for trumps.
  // Pulkas 2 and 4 (9 cards): nothing is turned up; the highest bidder names the trump after bidding.
  g.trumpChooser = null;
  if (g.cards < 9) {
    g.trumpCard = deck[4 * g.cards];
    g.trump = g.trumpCard.s === 'J' ? 'N' : g.trumpCard.s; // 'N' = no trumps (a joker was turned)
  } else {
    g.trumpCard = null;
    g.trump = null;
  }
  g.bids = [null, null, null, null];
  g.tricksWon = [0, 0, 0, 0];
  g.trick = [];
  g.lastTrick = null;
  g.lastWinner = null;
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
  } else if (g.cards === 9) {
    const max = Math.max(...g.bids);
    if (max === 0) {
      g.trump = 'N'; // everybody passed: no trumps
      g.phase = 'playing';
      g.turn = g.leader;
    } else {
      // the first player (in bidding order) with the highest bid names the trump
      g.trumpChooser = order.find(s => g.bids[s] === max);
      g.phase = 'trump';
      g.turn = g.trumpChooser;
    }
  } else {
    g.phase = 'playing';
    g.turn = g.leader;
  }
}

function chooseTrump(g, seat, suit) {
  if (g.phase !== 'trump') fail('არასწორი ფაზა');
  if (g.turn !== seat) fail('ახლა შენი რიგი არ არის');
  if (suit !== 'N' && !SUITS.includes(suit)) fail('არასწორი კოზირი');
  g.trump = suit;
  g.phase = 'playing';
  g.turn = g.leader;
}

function ledSuit(trick) {
  if (!trick.length) return undefined;
  const first = trick[0];
  return first.card.s !== 'J' ? first.card.s : first.suit;
}

function legalPlays(g, seat) {
  if (g.phase !== 'playing' || g.turn !== seat) return [];
  const hand = g.hands[seat];
  const all = hand.map(c => c.id);
  if (!g.trick.length) return all;
  const led = ledSuit(g.trick);
  const first = g.trick[0];
  const jokers = hand.filter(c => c.s === 'J');
  const ofLed = hand.filter(c => c.s === led);
  if (ofLed.length) {
    if (first.card.s === 'J' && first.mode === 'high') {
      // a high joker was led: must play the highest card of that suit (or the other joker)
      const top = ofLed.reduce((a, b) => (b.r > a.r ? b : a));
      return [top, ...jokers].map(c => c.id);
    }
    return [...ofLed, ...jokers].map(c => c.id);
  }
  if (g.trump !== 'N') {
    const trumps = hand.filter(c => c.s === g.trump);
    if (trumps.length) return [...trumps, ...jokers].map(c => c.id);
  }
  return all;
}

function play(g, seat, cardId, opts = {}) {
  if (g.phase !== 'playing') fail('არასწორი ფაზა');
  if (g.turn !== seat) fail('ახლა შენი რიგი არ არის');
  if (!legalPlays(g, seat).includes(cardId)) fail('ამ კარტის გათამაშება არ შეიძლება');
  const hand = g.hands[seat];
  const idx = hand.findIndex(c => c.id === cardId);
  const card = hand[idx];
  const entry = { seat, card };
  if (card.s === 'J') {
    entry.mode = opts.mode === 'low' ? 'low' : 'high';
    if (g.trick.length === 0) {
      if (!SUITS.includes(opts.suit)) fail('აირჩიე ჯოკერის ნიშანი');
      entry.suit = opts.suit; // the leader names the suit in both modes
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
  const first = trick[0];
  const led = ledSuit(trick);
  const highs = trick.filter(t => t.card.s === 'J' && t.mode === 'high');
  const cards = trick.filter(t => t.card.s !== 'J');
  const best = list => list.reduce((a, b) => (b.card.r > a.card.r ? b : a));
  const trumps = trump !== 'N' ? cards.filter(t => t.card.s === trump) : [];
  if (highs.length > 1) return highs[highs.length - 1].seat; // second high joker wins
  if (highs.length === 1) {
    // a led high joker (non-trump suit) can still be trumped
    if (highs[0] === first && led !== trump && trumps.length) return best(trumps).seat;
    return highs[0].seat;
  }
  if (trumps.length) return best(trumps).seat;
  const followers = cards.filter(t => t.card.s === led);
  if (followers.length) return best(followers).seat;
  return first.seat; // a low joker was led and nobody followed: it wins by default
}

function scoreFor(bid, taken, cards) {
  if (bid === 0) return taken === 0 ? 50 : taken * 10; // pass: 50 if nothing taken, else 10 per trick
  if (taken !== bid) return -200;
  if (bid === cards) return 100 * bid;
  return 50 + 50 * bid;
}

// Called by the server after the pause that follows the draw / a trick / a deal.
function advance(g) {
  if (g.phase === 'draw') {
    startDeal(g);
  } else if (g.phase === 'trickEnd') {
    g.tricksWon[g.trickWinner]++;
    g.lastTrick = g.trick;
    g.lastWinner = g.trickWinner;
    g.trick = [];
    g.leader = g.trickWinner;
    g.turn = g.trickWinner;
    if (g.hands.every(h => h.length === 0)) endDeal(g);
    else g.phase = 'playing';
  } else if (g.phase === 'dealEnd') {
    if (g.dealIdx + 1 >= DEALS.length) {
      g.phase = 'finished';
      g.turn = null;
    } else {
      startDeal(g);
    }
  }
}

function endDeal(g) {
  const points = g.bids.map((b, i) => scoreFor(b, g.tricksWon[i], g.cards));
  points.forEach((p, i) => { g.totals[i] += p; });
  const summary = {
    deal: g.dealIdx,
    pulka: g.pulka,
    cards: g.cards,
    dealer: g.dealer,
    trump: g.trump,
    bids: g.bids.slice(),
    taken: g.tricksWon.slice(),
    points,
    bonus: null,
  };
  g.history.push(summary);
  // Pulka premium: a player who made every bid of the pulka gets the last deal's score again.
  // If exactly one player got the premium, every other player loses their best single-deal score of the pulka.
  const nextSpec = DEALS[g.dealIdx + 1];
  if (!nextSpec || nextSpec.pulka !== g.pulka) {
    const rows = g.history.filter(h => h.pulka === g.pulka);
    const last = rows[rows.length - 1];
    const bonus = [0, 1, 2, 3].map(s => (rows.every(h => h.bids[s] === h.taken[s]) ? last.points[s] : 0));
    const winners = bonus.map((b, i) => (rows.every(h => h.bids[i] === h.taken[i]) ? i : -1)).filter(i => i >= 0);
    const cut = [0, 0, 0, 0];
    if (winners.length === 1) {
      for (let i = 0; i < 4; i++) if (i !== winners[0]) cut[i] = Math.max(0, ...rows.map(h => h.points[i]));
    }
    bonus.forEach((b, i) => { g.totals[i] += b - cut[i]; });
    if (bonus.some(Boolean)) { g.bonuses[g.pulka] = bonus; summary.bonus = bonus; }
    if (cut.some(Boolean)) { g.cuts[g.pulka] = cut; summary.cut = cut; }
  }
  g.dealSummary = summary;
  g.phase = 'dealEnd';
  g.turn = null;
}

function sortHand(hand) {
  const order = { J: 0, S: 1, H: 2, C: 3, D: 4 };
  return hand.slice().sort((a, b) => (order[a.s] - order[b.s]) || (b.r - a.r));
}

// Personalized view: never leaks other players' hands.
function viewFor(g, seat) {
  return {
    names: g.names,
    phase: g.phase,
    draw: g.draw,
    dealIdx: g.dealIdx,
    totalDeals: DEALS.length,
    pulka: g.pulka,
    cards: g.cards,
    dealer: g.dealer,
    turn: g.turn,
    bids: g.bids,
    trump: g.trump,
    trumpCard: g.trumpCard,
    trumpChooser: g.trumpChooser,
    trick: g.trick,
    trickWinner: g.phase === 'trickEnd' ? g.trickWinner : null,
    lastTrick: g.lastTrick,
    lastWinner: g.lastWinner,
    tricksWon: g.tricksWon,
    handCounts: g.hands.map(h => h.length),
    hand: seat >= 0 ? sortHand(g.hands[seat]) : [],
    legal: seat >= 0 ? legalPlays(g, seat) : [],
    forbiddenBid: seat >= 0 && g.turn === seat ? forbiddenBid(g, seat) : null,
    totals: g.totals,
    history: g.history,
    bonuses: g.bonuses,
    cuts: g.cuts,
    dealSummary: g.phase === 'dealEnd' ? g.dealSummary : null,
  };
}

module.exports = {
  SUITS, DEALS, newGame, bid, chooseTrump, play, advance, legalPlays,
  viewFor, trickWinner, scoreFor, ledSuit, buildDeck,
};
