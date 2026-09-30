'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Staff training on the three Ethical & Interest-Free structures.

   These exist because the EIF offering is the one place on the platform
   where a confident, helpful, WRONG sentence from a staff member is a
   compliance problem rather than a service one. Three in particular:

     · "It's Sharia certified."  It is not. Independent advisory review is
       under way and no certificate has been issued. The platform's own FAQ
       says "Not yet, and we will not say otherwise", and a staff member who
       says otherwise has made a claim the business cannot stand behind.
     · "You'll get 14.5%."  A Mudarabah target is a projection off a
       venture's own numbers. Promising a return on a profit-sharing
       partnership is the precise thing the structure exists to avoid.
     · "It's basically the same as the others, just interest-free."  The
       three structures allocate risk differently from each other and from
       every conventional product on the platform. Who carries what, and
       when the money stops, is the whole content of the offering.

   Content is written to be corrected: courses and modules are rows, and
   whoever is accountable for the wording can edit them in the console
   without a deploy.

   Every figure here is taken from EIF_PRODUCTS, EIF_FAQS and
   server/services/agreements.js rather than restated from memory. If a
   product parameter changes, check-eif-courses.cjs fails until this agrees
   with it again.
   ═══════════════════════════════════════════════════════════════════ */

/* Repeated at the end of all three courses. The rules that are the same
   whichever structure a client picks, in the words staff may use. */
const COMMON_COMPLIANCE = `<h3>What you may say, and what you may not</h3>
<p>These three products are the platform's Ethical &amp; Interest-Free range. Everything below applies to all three, and getting it wrong is a compliance matter rather than a style preference.</p>
<p><strong>Certification.</strong> The offering is <em>not</em> Sharia certified. It is <em>structured on</em> established Islamic finance principles — no riba, no gharar, no prohibited sectors, and a real asset or enterprise behind every return — and independent Sharia advisory review is under way. Until a certificate is issued and published, the sentence you use is: "These are structured on Islamic finance principles, and independent Sharia advisory review is under way. We do not yet hold a certificate, and we will not claim one." Never say "certified", "compliant", "approved" or "halaal-approved". If a client needs certainty before investing, tell them to take their own advice — that answer costs you nothing and protects both of you.</p>
<p><strong>Excluded sectors.</strong> No pool finances conventional interest-based lending, alcohol, tobacco, pork, gambling, adult entertainment or weapons. Every business a pool finances is screened against that list before the pool opens, and a business that moves into an excluded activity during the term is exited.</p>
<p><strong>The platform fee.</strong> 1% of the amount invested, charged <strong>on top of it</strong>, once. Enter R500 into a pool with a R500 minimum and R500 reaches the pool, R5,00 is the fee, and R505,00 leaves the wallet. It is the same whether the investment does well or badly, because it is a fee for the work of running the platform — administration, reporting, custody of the paperwork — and not a charge for the use of money. Never describe it as coming out of the investment.</p>
<p><strong>At maturity.</strong> Every EIF holding settles in cash to the client's wallet. There is no rollover and no switch into another product: each of these is a concluded contract over a specific trade, asset or venture, so when it ends the only thing that can happen is that it pays out. The maturity screen shows Payout All and nothing else for these products, and that is deliberate.</p>
<p><strong>Interest on the wallet.</strong> A client who holds an EIF product still keeps their money in the ordinary platform wallet, and interest earned on client balances is normally credited to them. Holding an EIF product does <em>not</em> switch that off — some clients hold both kinds and want it. There is a separate switch, "Decline interest on my wallet balance", under Invest → Ethical &amp; Interest-Free. Point a client at it rather than assuming either way.</p>
<p><strong>Who the client is contracting with.</strong> The provider is SmartVest Financial Services (Pty) Ltd, an authorised financial services provider, FSP 52449. SV Capital is the fund manager. Both names appear on the agreement, and the EFT account a client pays into is in the name Smartvest Financial Services — say so before they see it on a bank statement and worry.</p>
<p><strong>Capital is at risk on all three.</strong> None of them guarantees a return, and the rate shown is a target. That is not a disclaimer bolted on the end; on a Mudarabah in particular it is the structure.</p>`;

const COMMON_COMPLIANCE_POINTS = [
  'NOT certified: say "structured on Islamic finance principles, review under way, no certificate yet" — never "certified" or "compliant"',
  'Excluded sectors: conventional lending, alcohol, tobacco, pork, gambling, adult entertainment, weapons — screened before the pool opens',
  'Platform fee is 1% charged ON TOP, once: R500 invested means R505 leaves the wallet and R500 reaches the pool',
  'Every EIF holding pays out in cash at maturity — no rollover, no switch, by design',
  'Holding an EIF product does not stop wallet interest; the client elects that separately under Invest → Ethical & Interest-Free',
  'Provider is SmartVest Financial Services (Pty) Ltd, FSP 52449; SV Capital is the fund manager',
];

const EIF_COURSES = [

  /* ── MURABAHA ──────────────────────────────────────────────────── */
  {
    id: 'CRS-PROD-EIF-MURABAHA-001',
    title: 'Murabaha: Cost-Plus Trade Finance',
    description: 'How SV Capital earns a disclosed mark-up by actually buying and actually selling real goods — why that is a trade and not a loan, what the client is exposed to, and the sentences you may and may not use when you explain it.',
    category: 'products', difficulty: 'intermediate', estimated_minutes: 55,
    xp_reward: 220, role_target: 'all', kpi_dimension: 'compliance_score',
    kpi_boost_points: 12, modules_count: 4, quiz_questions: 12, pass_score: 70,
    is_required: true, thumbnail_icon: 'fa-handshake', thumbnail_color: '#078e07',
    learning_objectives: 'Explain what makes a Murabaha a sale rather than a loan, describe the order in which the steps must happen and why, quote the product\'s real terms, and answer the certification and late-payment questions without overclaiming.',
    modules: [
      {
        module_index: 1, title: 'What a Murabaha actually is', estimated_minutes: 14, xp_reward: 50,
        content: `<h3>A sale, with the mark-up shown</h3>
<p>Murabaha is a cost-plus sale. SV Capital buys a thing a business needs, takes ownership of it, and then sells it on to that business at a price made up of two disclosed parts: what it cost, and the mark-up. The buyer pays over time. What reaches the investor is a share of that mark-up.</p>
<p>The word that does the work is <strong>disclosed</strong>. In an ordinary trade a seller marks goods up and never tells the buyer by how much. In a Murabaha the cost and the mark-up are both stated in the contract before the buyer agrees to it. That is what makes the transaction a Murabaha rather than simply a sale on credit.</p>
<h3>Why this is not a loan</h3>
<p>The difference is not a label, and a client will test you on it. In a loan, money is advanced and more money comes back; the lender never touches the goods and is owed the money whatever happens to them. In a Murabaha, SV Capital <em>owns the goods</em> — briefly, but really — and for that period carries the risks of owning them. The profit arises from selling an asset for more than it cost, which is trade, and not from the passage of time on an advance, which is interest.</p>
<p>So the order of events is the substance, not paperwork:</p>
<ol>
<li>The business identifies what it needs — stock, equipment, raw materials.</li>
<li><strong>SV Capital buys it and takes ownership.</strong></li>
<li>The sale price is agreed and the mark-up disclosed in full.</li>
<li>The goods are sold on to the business, which pays over the agreed period.</li>
</ol>
<p>Reverse steps 2 and 4 — hand over cash and let the business buy the goods itself — and the transaction has become a loan with a fee on it, whatever the paperwork says. If a client asks "so you just lend them the money to buy it?", the answer is no, and the reason is this sequence.</p>
<h3>What gets financed</h3>
<p>Typical assets are production printers sold on to a printing business, maize inputs bought ahead of a planting season, and weaner calves sold on to a feedlot. In each case there is a physical thing that was bought and a business that needed it — the same test you apply to anything a Murabaha pool proposes to finance.</p>`,
        key_points: [
          'Murabaha is a cost-plus SALE: the cost and the mark-up are both disclosed before the buyer agrees',
          'SV Capital takes ownership of the goods before selling them on — that is what makes it trade rather than lending',
          'The order of events is the substance: buy, own, disclose, sell on. Advancing cash instead makes it a loan',
          'The return is a share of the mark-up on real goods, not a charge for time on an advance',
          'Typical assets: production printers, maize inputs ahead of planting, weaner calves sold on to a feedlot',
        ],
        quiz: [
          {
            question: "What single fact separates a Murabaha from a loan with a fee attached?",
            options: [
              "The mark-up is lower than the interest a bank would charge on the same amount",
              "The buyer repays in instalments over a fixed period agreed up front",
              "SV Capital owns the goods before selling them on, and carries that ownership risk",
              "The contract uses the language of sale rather than the language of lending",
            ],
            correct: 2,
            explanation: "The profit has to arise from a trade in something actually bought and actually sold. Ownership — real, even if brief — is what makes the return trading profit rather than a charge on an advance. The rate, the instalments and the wording achieve nothing on their own.",
          },
          {
            question: "A business wants a R400 000 printing press. Which sequence is a Murabaha?",
            options: [
              "SV Capital pays R400 000 to the business, which buys the press and repays R440 000",
              "SV Capital buys the press, owns it, then sells it on for a disclosed R440 000",
              "SV Capital guarantees the bank loan the business raises to buy the press itself",
              "SV Capital pays the supplier direct and the business repays SV Capital with interest",
            ],
            correct: 1,
            explanation: "Only the second has SV Capital owning the asset before selling it on at a price whose cost and mark-up are both disclosed. The first and fourth advance money against repayment, which is lending whatever it is called. The third is a guarantee, not a trade.",
          },
          {
            question: "What does the word \"disclosed\" require in a disclosed mark-up?",
            options: [
              "That the buyer is told the cost and the mark-up before agreeing to the sale",
              "That the mark-up is published on the SV Capital website before the pool opens",
              "That the investor is shown the mark-up once the sale has been completed",
              "That the mark-up has been reviewed and approved by the FSCA in advance",
            ],
            correct: 0,
            explanation: "Both components — what the goods cost and what the mark-up is — are stated to the buyer in the contract before they agree. An ordinary credit sale hides the margin inside a single price; a Murabaha shows it.",
          },
        ],
      },
      {
        module_index: 2, title: 'The mark-up is fixed, and what that costs us', estimated_minutes: 14, xp_reward: 55,
        content: `<h3>Fixed at the moment of sale</h3>
<p>Once the sale is struck, the price is the price. The mark-up does not grow with time, and it does not grow if the buyer pays late. A buyer who is ninety days overdue owes exactly what they owed on day one.</p>
<p>This is the sharpest practical difference between a Murabaha and any conventional credit product, and it is worth sitting with, because it is a real cost to the pool rather than a talking point. Conventional lending prices late payment: penalty interest accrues, and the lender is partly compensated for the delay. A Murabaha cannot do that, because a charge that grows with time is exactly the thing the structure exists to avoid. <strong>No penalty accrues to the investor.</strong> A late payer simply pays later.</p>
<h3>So what protects the pool?</h3>
<p>Not a penalty rate. Three other things:</p>
<ul>
<li><strong>Who we sell to.</strong> Because there is no way to price the risk of slow payment into the contract afterwards, it has to be priced in the choice of buyer beforehand. Counterparty selection does more work in a Murabaha than in any other structure on the platform.</li>
<li><strong>The goods themselves.</strong> The financing is backed by the goods and by the buyer's trade receivables.</li>
<li><strong>The term.</strong> Murabaha runs a shorter term than most products here — six months — which limits how far a position can drift.</li>
</ul>
<h3>Where the return can fall short</h3>
<p>Be straight with clients about this. The mark-up is fixed, so the upside is known and capped; the downside is that the buyer may pay late or not at all. Late payment does not reduce the amount owed, but it does mean the money comes back later than modelled, and a buyer who fails entirely leaves the pool holding a claim and, at best, the goods. "Fixed return" and "guaranteed return" are not the same sentence, and only the first one is true.</p>`,
        key_points: [
          'The mark-up is fixed at the moment of sale — it never grows with time or with late payment',
          'No penalty interest accrues to the investor: a late buyer owes exactly what they always owed',
          'Because late payment cannot be priced afterwards, the choice of buyer carries the risk instead',
          'Backed by the goods themselves and by the buyer\'s trade receivables',
          '"Fixed" is not "guaranteed": the buyer can still pay late, or fail',
        ],
        quiz: [
          {
            question: "A Murabaha buyer is ninety days late. What is owed to the pool?",
            options: [
              "The original amount, plus penalty interest accrued over the ninety days",
              "The original amount, plus an administration charge for the collection work",
              "The original amount reduced pro rata, since the goods have depreciated",
              "The original amount exactly — no penalty accrues to the investor at all",
            ],
            correct: 3,
            explanation: "The price is fixed at the moment of sale and cannot grow with time. A charge that accrues for delay is precisely what the structure avoids, so a late payer owes what they always owed. The cost of the delay falls on the pool.",
          },
          {
            question: "Late payment cannot be priced into a Murabaha after the sale. What carries that risk instead?",
            options: [
              "The choice of buyer, made before the goods are ever sold on",
              "A higher mark-up set in advance to compensate for expected delays",
              "Credit insurance taken out by the pool against late settlement",
              "A shortened payment period enforced by a penalty for overrunning",
            ],
            correct: 0,
            explanation: "Risk that cannot be priced afterwards has to be managed beforehand. Who the goods are sold to does more work in a Murabaha than in any other structure here, supported by the security of the goods and the trade receivables, and by the short six-month term.",
          },
          {
            question: "Which sentence may you use with a client about a Murabaha return?",
            options: [
              "\"The return is guaranteed, because the mark-up is fixed at the sale.\"",
              "\"The return is fixed and protected by penalty interest if they pay late.\"",
              "\"The mark-up is fixed, so the return is known — but capital is still at risk.\"",
              "\"The return grows the longer the buyer takes to settle what they owe.\"",
            ],
            correct: 2,
            explanation: "Fixed and guaranteed are different claims. The mark-up does not change, so the intended return is known; the buyer can still pay late or fail, so the capital is at risk. The other three are untrue of the structure.",
          },
        ],
      },
      {
        module_index: 3, title: 'The product as a client meets it', estimated_minutes: 13, xp_reward: 55,
        content: `<h3>Murabaha Trade Finance — the actual terms</h3>
<p>These are the figures on the product page. Know them without looking.</p>
<ul>
<li><strong>Minimum investment:</strong> R500 — the lowest of the three EIF structures</li>
<li><strong>Term:</strong> 6 months — the shortest of the three</li>
<li><strong>Benchmark rate:</strong> 11.5% per annum, prorated over the term</li>
<li><strong>Risk profile:</strong> Low-Medium — the lowest of the three</li>
<li><strong>Performance fee:</strong> none</li>
<li><strong>Platform fee:</strong> 1% of the amount invested, charged on top, once</li>
<li><strong>At maturity:</strong> pays out in cash to the wallet — no rollover, no switch</li>
</ul>
<p>The benchmark is a target drawn from the trade, not a promise. Murabaha and Ijara returns come from contracted amounts and are the more predictable of the three structures; that is a statement about predictability, not about guarantee.</p>
<h3>Who this suits</h3>
<p>The R500 minimum and six-month term make Murabaha the natural entry point into the range — a client who wants to hold something in the Ethical &amp; Interest-Free section without committing for three years, and a client who is testing the offering before moving more. It is also the one to reach for when a client says the returns elsewhere in the range are too uncertain for them: a fixed, disclosed mark-up over six months is the most predictable thing in this part of the platform.</p>
<h3>What the client signs</h3>
<p>Before any money moves, the client signs a <strong>Murabaha Investment Agreement</strong> — its own contract, not the standard one. They tick three acknowledgements individually:</p>
<ul>
<li>that the return is a share of a mark-up fixed at the time of sale, which does not grow if the buyer pays late;</li>
<li>that the 1% platform fee is charged on top of the amount invested;</li>
<li>that capital is committed until the maturity date and cannot be withdrawn on demand.</li>
</ul>
<p>If a client pushes back on any of those three at the signing screen, that is the conversation to have properly rather than to talk them through. The agreement records that they were told, and it is the first document an ombud asks for.</p>`,
        key_points: [
          'Murabaha Trade Finance: R500 minimum, 6-month term, 11.5% benchmark, Low-Medium risk, no performance fee',
          'Shortest term and lowest minimum of the three EIF structures — the natural entry point',
          'The benchmark is a target drawn from the trade, not a promise',
          'Pays out in cash at maturity like every EIF product',
          'The client signs a Murabaha Investment Agreement and ticks three acknowledgements one at a time',
        ],
        quiz: [
          {
            question: "What are the minimum investment and term for Murabaha Trade Finance?",
            options: [
              "R2 500 and twelve months",
              "R1 000 and thirty-six months",
              "R500 and twelve months",
              "R500 and six months",
            ],
            correct: 3,
            explanation: "R500 and six months — the lowest minimum and the shortest term of the three EIF structures, which is what makes it the usual entry point into the range.",
          },
          {
            question: "A client says the Ethical & Interest-Free returns feel too uncertain. Which structure is most predictable?",
            options: [
              "Murabaha, because the mark-up is fixed and disclosed at the time of sale",
              "Mudarabah, because its target rate is the highest of the three structures",
              "Ijara, because a three-year lease contracts the income for the longest",
              "None of them — all three carry the same degree of uncertainty",
            ],
            correct: 0,
            explanation: "Murabaha and Ijara both come from contracted amounts and are the more predictable of the three; Murabaha most of all, because the mark-up is fixed at the moment of sale. Mudarabah is the least predictable — its figure is a projection off a venture's own numbers.",
          },
          {
            question: "Which acknowledgement does a client NOT tick on the Murabaha agreement?",
            options: [
              "That the return is a share of a mark-up fixed at the time of sale",
              "That a loss falls on their capital while the operator forfeits profit",
              "That the 1% platform fee is charged on top of the amount invested",
              "That capital is committed until maturity and not repayable on demand",
            ],
            correct: 1,
            explanation: "The loss-falls-on-capital acknowledgement is Mudarabah's and belongs to that structure alone. Murabaha carries the fixed mark-up, the fee-on-top and the term acknowledgements, each ticked separately — a single box covering everything acknowledges nothing in particular.",
          },
        ],
      },
      {
        module_index: 4, title: 'Explaining it, and the lines you do not cross', estimated_minutes: 14, xp_reward: 60,
        content: `<h3>The explanation that works</h3>
<p>Short, concrete, and in the order the client's questions arrive:</p>
<p>"A business needs something — say a R400 000 printing press. We buy the press. We own it. Then we sell it to them for R440 000, payable over six months, and both those numbers are in their contract before they sign. The R40 000 is the mark-up, and your return is a share of it. We are not lending them money; we bought a thing and sold it on."</p>
<p>Then the follow-up almost every client asks — <em>"isn't that just interest with extra steps?"</em> — and the answer is the risk, not the vocabulary: "If it were a loan, we would be owed the money whatever happened to the press. Because we bought it, we carried it. And the mark-up is fixed on the day of the sale: if they pay ninety days late, they owe exactly what they always owed. No interest accrues. A lender would have charged for that delay; we cannot."</p>
${COMMON_COMPLIANCE}`,
        key_points: [
          'Explain with a concrete asset, in the order of the client\'s questions: we bought it, we owned it, we sold it on at a disclosed mark-up',
          'Answer "isn\'t this just interest?" with the risk and the late-payment rule, not with vocabulary',
          ...COMMON_COMPLIANCE_POINTS,
        ],
        quiz: [
          {
            question: "A client asks whether the Murabaha product is Sharia certified. What do you say?",
            options: [
              "\"Yes — all three products in the range are certified by our Sharia board.\"",
              "\"Effectively yes; the certificate is a formality that has not been issued.\"",
              "\"Structured on Islamic principles, review under way, no certificate held.\"",
              "\"I am not permitted to discuss questions about certification with clients.\"",
            ],
            correct: 2,
            explanation: "No certificate has been issued. The platform's own FAQ says \"Not yet, and we will not say otherwise.\" Claiming certification is a claim the business cannot stand behind, and inviting the client to take their own advice is a complete answer rather than a failed close.",
          },
          {
            question: "A client invests R2 000 into an EIF pool with a R2 000 minimum. What happens to the money?",
            options: [
              "R2 000 reaches the pool, R20 is charged on top, and R2 020 leaves the wallet",
              "R1 980 reaches the pool and R20 is retained as the platform fee",
              "R2 000 leaves the wallet and the fee is taken from the return at maturity",
              "No fee applies, because interest-free products are exempt from it",
            ],
            correct: 0,
            explanation: "The fee is 1% charged ON TOP of the amount invested, once. The full amount the client enters reaches the pool, and the wallet pays that amount plus the fee. Describing it as coming out of the investment is wrong on every product on this platform.",
          },
          {
            question: "A Murabaha matures and the client asks you to roll it into the next pool. What is true?",
            options: [
              "Rollover is available, but only on amounts above R50 000 invested",
              "You may set their maturity instruction to Reinvest on their behalf",
              "It settles in cash to the wallet — EIF products do not roll over or switch",
              "They must contact the FSP directly to arrange the rollover themselves",
            ],
            correct: 2,
            explanation: "EIF products are payout-only at maturity by design: each concerns a specific trade, asset or venture, so when that concludes the only thing that can happen is a cash settlement. The maturity screen offers Payout All and nothing else. They can invest again from the wallet afterwards.",
          },
        ],
      },
    ],
  },

  /* ── IJARA ─────────────────────────────────────────────────────── */
  {
    id: 'CRS-PROD-EIF-IJARA-001',
    title: 'Ijara: Renting Out an Asset the Pool Owns',
    description: 'Why rent on an owned asset is not interest on a loan, what the pool takes on by holding title, when the income stops, and how to explain all of that to a client using the delivery fleet they can picture.',
    category: 'products', difficulty: 'intermediate', estimated_minutes: 55,
    xp_reward: 230, role_target: 'all', kpi_dimension: 'compliance_score',
    kpi_boost_points: 12, modules_count: 4, quiz_questions: 12, pass_score: 70,
    is_required: true, thumbnail_icon: 'fa-file-contract', thumbnail_color: '#078e07',
    learning_objectives: 'Explain why ownership makes rental income something other than interest, list the costs and risks the pool carries as owner, quote the product\'s real terms, and say plainly when the income stops.',
    modules: [
      {
        module_index: 1, title: 'Rent is not interest, and the difference is the risk', estimated_minutes: 14, xp_reward: 55,
        content: `<h3>The pool buys the thing and keeps the title</h3>
<p>In an Ijara the pool purchases an income-producing asset — delivery vehicles, a solar plant, plant and machinery — and <strong>holds title to it for the life of the lease</strong>. The asset is leased to an operator who uses it to earn, and the investor's return is a share of the rental.</p>
<p>The whole structure turns on that ownership, and the cleanest way to see why is to put a lender and an owner side by side:</p>
<p><strong>A lender is owed money whatever happens to the thing the money bought.</strong> The bike is stolen, the press breaks, the plant sits idle — the borrower still owes every instalment. The lender's return was never connected to the asset; it was a charge for the use of money.</p>
<p><strong>An owner is owed rent only while the asset can be used.</strong> If it cannot be used, the rent stops. That exposure is not a flaw in the product; it is the thing that makes the income rent rather than a charge for the use of money.</p>
<h3>The delivery fleet, which every client can picture</h3>
<p>A pool funds a fleet of delivery motorcycles. It buys the bikes and keeps title to them. Riders working Mr D, Takealot and Uber Eats lease them — people who need a machine to earn and would otherwise be renting one on worse terms. What reaches the investor is a share of that rent.</p>
<p>Because the pool owns the bikes, it carries the costs of ownership: insurance and major maintenance sit with the pool rather than the rider. And it carries the consequence when bikes come off the road. <strong>Bikes not being ridden are bikes not paying.</strong></p>
<h3>What that means for the investor</h3>
<p>The question a client is really asking is not where the return comes from but what has to happen for it to be earned. In an Ijara the income comes from the productive use of an asset: if the asset is generating rent, investors share in that rental income; if the asset is not deployed, the income can be affected. Say that out loud before they ask.</p>`,
        key_points: [
          'The pool buys the asset and holds title for the life of the lease — the return is rent, not interest',
          'A lender is owed money whatever happens to the asset; an owner is owed rent only while it can be used',
          'That exposure is what makes the income rent rather than a charge for the use of money',
          'Insurance and major maintenance sit with the pool as owner, not with the lessee',
          'If the asset is not deployed, the income can be affected — say so before the client asks',
        ],
        quiz: [
          {
            question: "What makes Ijara rental income something other than interest?",
            options: [
              "The payments are described as rent throughout the lease agreement",
              "The rate is set below what a lender would charge on the same asset",
              "The lessee holds an option to buy the asset at the end of the term",
              "The pool owns the asset, so if it cannot be used the rent stops",
            ],
            correct: 3,
            explanation: "Ownership, and the exposure that comes with it. A lender is owed money whatever happens to the asset; an owner is owed rent only while the asset can be used. Naming the payments \"rent\" achieves nothing on its own.",
          },
          {
            question: "Bikes financed by an Ijara pool are off the road for a month after an accident. Who carries it?",
            options: [
              "The pool, as owner — idle bikes pay no rent, and it insures and maintains them",
              "The riders, who owe the rent for the month regardless of the accident",
              "The delivery platform the riders were working for at the time",
              "Investors, through a temporary increase in the platform fee",
            ],
            correct: 0,
            explanation: "The pool owns the bikes, so it carries both the costs of ownership and the loss of rent when they cannot be used. That is precisely the ownership risk that makes the income rent. A lender would have been owed the money anyway.",
          },
          {
            question: "A client asks what has to happen for their Ijara return to be earned. What is accurate?",
            options: [
              "Nothing further — the lease is signed, so the income is already contracted",
              "The asset must be deployed and earning; if it is not, the income can be affected",
              "The operator must remain profitable across its business as a whole",
              "The asset must hold its value over the full three years of the lease",
            ],
            correct: 1,
            explanation: "The income comes from the productive use of the asset. A signed lease does not make it unconditional — the rent depends on the asset being usable and deployed, which is the honest shape of the product.",
          },
        ],
      },
      {
        module_index: 2, title: 'What the pool takes on as owner', estimated_minutes: 13, xp_reward: 55,
        content: `<h3>Ownership is a bundle of costs, not just a label</h3>
<p>Calling the pool the owner is not a drafting choice — it decides who pays for what, and the client should understand it because it is part of what their return is buying.</p>
<ul>
<li><strong>Insurance</strong> is the owner's cost. The pool insures the asset; the lessee does not.</li>
<li><strong>Major maintenance</strong> is the owner's cost. Day-to-day running is the user's; the substantial work that keeps the asset usable sits with the pool.</li>
<li><strong>Idle time</strong> is the owner's loss. When the asset is not in productive use, the rent it would have earned does not arrive.</li>
<li><strong>Residual value</strong> is the owner's exposure. The pool is holding a real thing that ages.</li>
</ul>
<p>That bundle is the reason an Ijara can pay a return at all without it being interest, and it is also why the risk profile is Medium rather than Low — higher than a Murabaha, where the position is short and backed by goods and receivables.</p>
<h3>The end of the lease</h3>
<p>The lease may provide an option to transfer the asset to the lessee at the end of the term. Note the word <strong>option</strong>. It is not automatic, and you should not describe it as a sale that is going to happen — a rider who has leased a bike for three years may take that option or may not.</p>
<h3>Term, and why it is long</h3>
<p>Ijara runs 36 months, much the longest of the three structures, and there is a reason a client will accept once it is said: the pool has bought a physical asset and has to hold it long enough for the rental to repay the purchase and produce a return. You cannot buy a fleet and lease it for six months. The length of the term is a consequence of the structure, not a commercial preference, and clients respond far better to that than to "that's just the product".</p>`,
        key_points: [
          'Insurance and major maintenance are the pool\'s costs as owner; day-to-day running is the user\'s',
          'Idle time and residual value are the owner\'s exposure too',
          'That bundle of ownership costs is why the income is rent — and why the risk profile is Medium rather than Low',
          'Any transfer of the asset to the lessee at the end is an OPTION, never something to present as certain',
          'The 36-month term follows from having bought a real asset that must be held long enough to repay itself',
        ],
        quiz: [
          {
            question: "Which costs sit with the pool rather than the lessee in an Ijara?",
            options: [
              "Fuel, tyres and the day-to-day running of the asset in service",
              "Insurance and major maintenance, as the costs of owning the asset",
              "None — the lessee bears every cost, which is what makes it a lease",
              "Only the original purchase price, with all later costs on the user",
            ],
            correct: 1,
            explanation: "Insurance and major maintenance are borne by the pool as owner; day-to-day running stays with the user. Carrying the costs of ownership is part of what makes the income rent rather than a charge on an advance.",
          },
          {
            question: "How should you describe the end-of-term transfer of the asset to a client?",
            options: [
              "As a guaranteed sale that returns additional capital to investors",
              "As a legal requirement that applies to every Ijara lease written",
              "As an option the lease may provide, which is not automatic",
              "As something that happens once the asset is fully depreciated",
            ],
            correct: 2,
            explanation: "The lease MAY provide an option to transfer the asset to the lessee. Presenting an option as a certainty overstates the product and builds an expectation the structure does not support.",
          },
          {
            question: "Why does Ijara run thirty-six months when Murabaha runs six?",
            options: [
              "Because longer commitments are rewarded with a higher target rate",
              "Because the pool bought a real asset and must hold it long enough to repay it",
              "Because regulation sets a minimum lease term for asset finance",
              "Because it aligns the maturity with the client's tax year end",
            ],
            correct: 1,
            explanation: "The term follows from the structure. You cannot buy a fleet, lease it for six months and expect the rental to cover the purchase. Clients accept that explanation far more readily than being told it is simply the product.",
          },
        ],
      },
      {
        module_index: 3, title: 'The product as a client meets it', estimated_minutes: 13, xp_reward: 55,
        content: `<h3>Ijara Asset Leasing — the actual terms</h3>
<ul>
<li><strong>Minimum investment:</strong> R1 000</li>
<li><strong>Term:</strong> 36 months — the longest of the three</li>
<li><strong>Benchmark rate:</strong> 12.5% per annum</li>
<li><strong>Risk profile:</strong> Medium</li>
<li><strong>Performance fee:</strong> none</li>
<li><strong>Platform fee:</strong> 1% of the amount invested, charged on top, once</li>
<li><strong>At maturity:</strong> pays out in cash to the wallet — no rollover, no switch</li>
</ul>
<p>Typical assets are delivery vehicles leased to a logistics operator and production printers leased to the business using them.</p>
<h3>Who this suits, and who it does not</h3>
<p>Three years is a real commitment and the capital is not repayable on demand. This suits a client who has money they will not need for that period and who wants the Ethical &amp; Interest-Free range with a contracted income behind it. It does not suit a client who may need the capital sooner — and that is a suitability question you have to ask rather than wait to be told about. A client who needs the money in eighteen months should be in a Murabaha or nothing.</p>
<h3>What the client signs</h3>
<p>An <strong>Ijara Investment Agreement</strong>, with three acknowledgements ticked one at a time:</p>
<ul>
<li>that their return is rent on an asset the pool owns, and that <strong>the rent stops if the asset cannot be used</strong>;</li>
<li>that the 1% platform fee is charged on top of the amount invested;</li>
<li>that capital is committed until maturity and cannot be withdrawn on demand.</li>
</ul>
<p>The first of those is the one clients skim and the one that matters most. If they have not understood that the income depends on the asset being in productive use, they have not understood the product, and signing does not fix that.</p>`,
        key_points: [
          'Ijara Asset Leasing: R1 000 minimum, 36-month term, 12.5% benchmark, Medium risk, no performance fee',
          'The longest term of the three structures — capital is not repayable on demand for three years',
          'Ask the suitability question: a client who may need the capital within three years should not be here',
          'The agreement\'s key acknowledgement is that the rent stops if the asset cannot be used',
          'Pays out in cash at maturity like every EIF product',
        ],
        quiz: [
          {
            question: "What are the minimum investment and term for Ijara Asset Leasing?",
            options: [
              "R1 000 and thirty-six months",
              "R500 and six months",
              "R2 500 and twelve months",
              "R1 000 and twelve months",
            ],
            correct: 0,
            explanation: "R1 000 and thirty-six months — the longest term of the three EIF structures, because the pool has to hold a real asset long enough for the rental to repay it.",
          },
          {
            question: "A client has R30 000 they will need for a house deposit in about eighteen months. What do you do?",
            options: [
              "Recommend Ijara, since 12.5% is the best available fit for that amount",
              "Recommend Ijara and mention that early withdrawal can be requested",
              "Split it between Ijara and Mudarabah so the average term is shorter",
              "Explain that Ijara locks capital for three years, so it cannot suit that money",
            ],
            correct: 3,
            explanation: "Suitability comes before the rate. Ijara commits capital for three years with no withdrawal on demand, so it cannot suit money needed in eighteen months — and splitting it across two products shortens neither term.",
          },
          {
            question: "Which acknowledgement is specific to the Ijara agreement?",
            options: [
              "That the mark-up is fixed at sale and does not grow with late payment",
              "That the platform fee is charged on top of the amount being invested",
              "That the return is rent, and the rent stops if the asset cannot be used",
              "That a loss falls on capital while the operator forfeits their profit share",
            ],
            correct: 2,
            explanation: "The rent-stops acknowledgement belongs to Ijara. The first is Murabaha's, the last is Mudarabah's, and the fee-on-top acknowledgement is carried by all of them.",
          },
        ],
      },
      {
        module_index: 4, title: 'Explaining it, and the lines you do not cross', estimated_minutes: 15, xp_reward: 65,
        content: `<h3>The explanation that works</h3>
<p>Use the fleet. It is concrete, it is real, and every client has seen the bikes:</p>
<p>"The pool buys delivery motorcycles and keeps them in its own name. Riders working Mr D, Takealot and Uber Eats lease them — people who need a machine to earn and would otherwise be renting one on worse terms. Your return is a share of that rent. We insure the bikes and we pay for the major maintenance, because we own them."</p>
<p>Then the part that is easy to leave out and should not be: "And because we own them, when the bikes are not being ridden they are not paying. A lender would still be owed the money. We would not. That is the difference between rent and interest, and it is also the risk you are taking."</p>
<h3>The objection you will actually get</h3>
<p><em>"Three years is a long time."</em> It is. Do not talk it down — explain it: the pool bought physical assets and has to hold them long enough for the rental to repay the purchase and produce a return. Then offer the honest alternative rather than pushing: Murabaha runs six months at a R500 minimum, and a client who is not ready to commit for three years should start there. A client placed into the wrong term is a complaint waiting to be written, and the shorter product is a real answer, not a consolation.</p>
${COMMON_COMPLIANCE}`,
        key_points: [
          'Lead with the fleet — concrete, real, and every client has seen the bikes',
          'Do not leave out the downside: bikes not being ridden are bikes not paying, and a lender would still have been owed',
          'Answer "three years is a long time" by explaining why the term follows from the structure, then offering Murabaha honestly',
          ...COMMON_COMPLIANCE_POINTS,
        ],
        quiz: [
          {
            question: "Which sentence about certification may you use with a client?",
            options: [
              "\"The range is Sharia compliant, which is why it sits in its own section.\"",
              "\"Structured on Islamic principles; review under way and no certificate.\"",
              "\"Our Sharia board signed these products off before they were launched.\"",
              "\"Certification is pending and should be confirmed within about a month.\"",
            ],
            correct: 1,
            explanation: "Only the second is true. No certificate has been issued, none is promised by a date, and \"compliant\" and \"approved\" are both claims the business cannot stand behind. Naming a timeline invents a commitment nobody has made.",
          },
          {
            question: "Which of these would an EIF pool be permitted to finance?",
            options: [
              "A bottle store expanding into a second retail location",
              "A logistics operator buying refrigerated delivery vehicles",
              "A short-term lender funding its consumer loan book",
              "A tobacco distributor upgrading its warehouse racking",
            ],
            correct: 1,
            explanation: "Conventional interest-based lending, alcohol and tobacco are all on the excluded list, alongside pork, gambling, adult entertainment and weapons. Every business a pool finances is screened against that list before the pool opens, and one that moves into an excluded activity during the term is exited.",
          },
          {
            question: "A client holding an Ijara asks whether interest still accrues on their wallet balance. What is true?",
            options: [
              "It stops automatically as soon as they hold any EIF product",
              "It never applied, because EIF clients use a separate wallet entirely",
              "It continues unless they switch it off themselves under the EIF tab",
              "It continues, and there is no way for the client to decline it",
            ],
            correct: 2,
            explanation: "Holding an EIF product does not switch off wallet interest — some clients hold both kinds and want it. There is a separate election, \"Decline interest on my wallet balance\", under Invest → Ethical & Interest-Free. Point the client at it rather than assuming either way.",
          },
        ],
      },
    ],
  },

  /* ── MUDARABAH ─────────────────────────────────────────────────── */
  {
    id: 'CRS-PROD-EIF-MUDARABAH-001',
    title: 'Mudarabah: Sharing the Profit, and the Loss',
    description: 'The partnership structure where the investor provides capital and a vetted operator provides the work — how profit is split, who carries a loss, and why nothing here may ever be described as a promise.',
    category: 'products', difficulty: 'advanced', estimated_minutes: 60,
    xp_reward: 250, role_target: 'all', kpi_dimension: 'compliance_score',
    kpi_boost_points: 15, modules_count: 4, quiz_questions: 13, pass_score: 70,
    is_required: true, thumbnail_icon: 'fa-scale-balanced', thumbnail_color: '#078e07',
    learning_objectives: 'Explain the roles of capital provider and operating partner, state the profit ratio and the loss rule exactly, quote the product\'s real terms, and hold the line that a Mudarabah target is a projection and never a promise.',
    modules: [
      {
        module_index: 1, title: 'A partnership, not a facility', estimated_minutes: 15, xp_reward: 60,
        content: `<h3>Two contributions, two roles</h3>
<p>A Mudarabah is a partnership between someone who provides money and someone who provides work.</p>
<ul>
<li>The investor is the <strong>rabb al-mal</strong> — the capital provider. They put up the money and take no part in running the venture.</li>
<li>The vetted operating partner is the <strong>mudarib</strong> — they provide the expertise and the labour, and they run it.</li>
</ul>
<p>Neither is lending to the other. They are in the venture together on terms agreed before a rand is deployed, and what each of them gets depends on how the venture actually does.</p>
<h3>Why nothing can be promised</h3>
<p>This is the point of the whole structure, and it is where a well-meaning staff member does the most damage.</p>
<p>A promised return on a partnership is the thing a Mudarabah exists to avoid. If the capital provider were guaranteed a fixed amount back regardless of how the venture performed, they would not be a partner at all — they would be a lender, and the payment would be a charge for the use of money. <strong>The absence of a promise is not a weakness in the product. It is the product.</strong></p>
<p>So the figure on the page is a target drawn from the venture's own projections and nothing more. Do not round it up, do not call it expected, and do not say "you'll get". Murabaha and Ijara returns come from contracted amounts and are the more predictable of the three; a Mudarabah figure is a projection.</p>
<h3>What gets financed</h3>
<p>Typical ventures are a 120-day cattle feedlot cycle and a maize season funded from inputs through to harvest — real enterprises with real operating cycles, where the profit exists only once the thing has actually been done. The investor receives reporting on the underlying venture each quarter, which is a genuine feature to mention: they can see how the thing they are in is going.</p>`,
        key_points: [
          'The investor is the rabb al-mal (capital); the vetted operating partner is the mudarib (the work). Neither lends to the other',
          'A promised return would make the investor a lender rather than a partner — which is what the structure exists to avoid',
          'The figure shown is a target drawn from the venture\'s own projections. Never "expected", never "you\'ll get"',
          'Typical ventures: a 120-day cattle feedlot cycle, a maize season from inputs through to harvest',
          'Investors receive reporting on the underlying venture each quarter',
        ],
        quiz: [
          {
            question: "In a Mudarabah, what does the operating partner (mudarib) contribute?",
            options: [
              "Half the capital, matched against the investors' contribution",
              "The expertise and the labour needed to run the venture",
              "A guarantee over the investors' capital for the term",
              "Security taken across the venture's underlying assets",
            ],
            correct: 1,
            explanation: "The investor provides the capital as rabb al-mal and the operating partner provides the work as mudarib. The mudarib contributes no capital and guarantees nothing — which is exactly why the loss rule works as it does.",
          },
          {
            question: "Why can a Mudarabah return never be promised in advance?",
            options: [
              "Because the FSCA prohibits guaranteed returns on every investment",
              "Because a guarantee would make the investor a lender, not a partner",
              "Because the length of each venture cycle varies too much to model",
              "Because the operating partner declines to commit to any figure",
            ],
            correct: 1,
            explanation: "If the capital provider were guaranteed a fixed amount regardless of performance, the payment would be a charge for the use of money and they would be a lender. The absence of a promise is not a gap in the product — it is the structure working.",
          },
          {
            question: "Which phrasing may you use about the Mudarabah rate?",
            options: [
              "\"You will earn 14.5% a year on the amount you put in.\"",
              "\"We expect 14.5%, and it has not missed that figure yet.\"",
              "\"14.5% is the floor; in a good season it runs higher than that.\"",
              "\"14.5% is a target from the venture's projections, not a promise.\"",
            ],
            correct: 3,
            explanation: "Only the last is true of the structure. A Mudarabah figure is a projection off the venture's own numbers; describing it as earned, expected or a floor misrepresents a partnership as a facility.",
          },
        ],
      },
      {
        module_index: 2, title: 'The ratio, and who carries a loss', estimated_minutes: 15, xp_reward: 60,
        content: `<h3>Profit: 80 / 20, fixed before any money moves</h3>
<p>Profit is divided on a ratio agreed before a rand is deployed: <strong>80% to investors and 20% to the operating partner</strong>. Agreeing the split in advance — rather than a fixed amount — is a requirement of the structure: a ratio shares whatever the venture makes, while a fixed amount would be a promise by another name.</p>
<p>The operating partner's 20% is recorded on the product as a performance fee, and it is worth being clear with clients about what that means: the mudarib is paid out of profit. If there is no profit, there is no 20%.</p>
<h3>Loss: it falls on the capital</h3>
<p>This is the hardest sentence in the range and you must be able to say it without flinching.</p>
<p><strong>A loss of the venture falls on the capital.</strong> The operating partner forfeits their share of the profit rather than contributing to the loss, and does not owe the investor the shortfall.</p>
<p>Clients hear that as unfair, so have the reason ready. The two partners contributed different things, and each loses what they contributed. The investor loses money, because money is what they put in. The operating partner loses months of work, paid nothing, because work is what they put in. Requiring the mudarib to cover a cash loss as well would turn their contribution into a guarantee, and a guaranteed partnership is a loan.</p>
<p>So when a client asks "what happens if the pool loses money?", the answer is: you would receive less than you invested, and that applies across the platform. In a Mudarabah the loss falls specifically on the capital, and the operating partner loses their share of the profit rather than sharing the loss — which is the structure working as intended, not a term against you. No product on this platform guarantees a return.</p>
<h3>What this changes about how you sell it</h3>
<p>Mudarabah is the highest risk of the three EIF structures and carries the highest potential share. It is not the product to reach for when a client is nervous, and it is not the one to put a first-time investor into because the headline number is the biggest. If a client's real question is "which is safest?", the answer is Murabaha.</p>`,
        key_points: [
          'Profit is split 80% investors / 20% operating partner, on a ratio fixed before any capital is deployed',
          'A ratio rather than a fixed amount is required — a fixed amount would be a promise by another name',
          'A loss falls on the CAPITAL. The operating partner forfeits their profit share and does not owe the shortfall',
          'The reason is that each partner loses what they contributed: the investor money, the operator months of unpaid work',
          'Highest risk of the three structures — not the one for a nervous client or a first-time investor',
        ],
        quiz: [
          {
            question: "How is profit divided in an SV Capital Mudarabah?",
            options: [
              "80% to investors and 20% to the operator, as a ratio fixed in advance",
              "Equally between the investors and the operating partner running it",
              "Investors take a fixed 14.5% and the operator keeps whatever remains",
              "Investors take everything until capital is repaid, then it is halved",
            ],
            correct: 0,
            explanation: "80/20, fixed in advance as a RATIO. A fixed amount to investors would be a promise by another name and would make them lenders rather than partners.",
          },
          {
            question: "A Mudarabah venture makes a loss. What happens?",
            options: [
              "The operating partner repays the investors out of their own funds",
              "The loss is shared 80/20, in the same ratio that profit would have been",
              "The loss falls on the capital; the operator forfeits profit, owing nothing",
              "SV Capital absorbs the loss out of the platform fee it has collected",
            ],
            correct: 2,
            explanation: "Each partner loses what they contributed — the investor money, the operator months of unpaid work. Requiring the mudarib to cover a cash loss would turn their contribution into a guarantee, and a guaranteed partnership is a loan.",
          },
          {
            question: "A cautious first-time investor asks which product in the range is safest. What do you say?",
            options: [
              "Mudarabah, on the basis that it targets the highest return",
              "Ijara, because the pool holds title to a physical asset throughout",
              "Murabaha — the lowest risk profile, a fixed mark-up and six months",
              "Whichever carries the lowest minimum, without reference to risk",
            ],
            correct: 2,
            explanation: "Murabaha carries the Low-Medium profile, the shortest term and the most predictable return of the three. Mudarabah is Medium-High and the least predictable; placing a nervous first-time investor there because the headline number is biggest is a suitability failure.",
          },
        ],
      },
      {
        module_index: 3, title: 'The product as a client meets it', estimated_minutes: 14, xp_reward: 60,
        content: `<h3>Mudarabah Enterprise — the actual terms</h3>
<ul>
<li><strong>Minimum investment:</strong> R2 500 — the highest of the three</li>
<li><strong>Term:</strong> 12 months</li>
<li><strong>Target rate:</strong> 14.5% per annum — the highest of the three, and a projection rather than a benchmark on contracted amounts</li>
<li><strong>Risk profile:</strong> Medium-High — the highest of the three</li>
<li><strong>Operating partner's share:</strong> 20% of profit, recorded as a performance fee</li>
<li><strong>Platform fee:</strong> 1% of the amount invested, charged on top, once</li>
<li><strong>Reporting:</strong> on the underlying venture each quarter</li>
<li><strong>At maturity:</strong> pays out in cash to the wallet — no rollover, no switch</li>
</ul>
<h3>The two fees, which clients confuse</h3>
<p>Be precise, because these are different things and a client who conflates them will feel misled later.</p>
<ul>
<li>The <strong>platform fee</strong> is 1% of what they invest, charged on top of it, once, at the time of investment. It is charged whether the venture does well or badly, because it pays for running the platform.</li>
<li>The <strong>operating partner's 20%</strong> is a share of profit, and only of profit. No profit, no 20%.</li>
</ul>
<h3>What the client signs</h3>
<p>A <strong>Mudarabah Investment Agreement</strong> — the only one in the range carrying four acknowledgements, each ticked separately:</p>
<ul>
<li>that if the venture loses money the loss falls on the capital they provided, and the operating partner forfeits their share of the profit instead of covering it;</li>
<li>that the figure shown is a target, not a promise, and their capital is at risk;</li>
<li>that the 1% platform fee is charged on top of the amount invested;</li>
<li>that capital is committed until maturity and cannot be withdrawn on demand.</li>
</ul>
<p>Four separate boxes, because a single box covering everything acknowledges nothing in particular — and it is the first thing an ombud asks about.</p>`,
        key_points: [
          'Mudarabah Enterprise: R2 500 minimum, 12-month term, 14.5% target, Medium-High risk',
          'The 14.5% is a projection off the venture\'s own numbers, not a benchmark on contracted amounts',
          'Two different fees: the 1% platform fee charged on top at investment, and the operator\'s 20% share of PROFIT only',
          'Quarterly reporting on the underlying venture',
          'Four acknowledgements on the agreement — the only product in the range with four',
        ],
        quiz: [
          {
            question: "What are the minimum investment and target rate for Mudarabah Enterprise?",
            options: [
              "R500 and 11.5%",
              "R2 500 and 14.5%",
              "R1 000 and 12.5%",
              "R2 500 and 20%",
            ],
            correct: 1,
            explanation: "R2 500 and a 14.5% target — the highest minimum and the highest target of the three, matching the highest risk profile. The 20% is the operating partner's share of profit, not a rate offered to investors.",
          },
          {
            question: "Is the operating partner's 20% deducted even when the venture does badly?",
            options: [
              "Yes — it is charged on the amount invested, like the platform fee",
              "Yes, but reduced to half where the venture returns less than target",
              "No — it is a share of profit only, so no profit means no 20%",
              "No — it is deducted from the client's capital at the outset instead",
            ],
            correct: 2,
            explanation: "The operating partner is paid out of profit. The 1% platform fee is the one charged regardless, on top of the amount invested, because it pays for running the platform rather than for the venture succeeding.",
          },
          {
            question: "Why does the Mudarabah agreement carry four acknowledgements rather than three?",
            options: [
              "Because it adds the loss rule and target-not-a-promise to fee and term",
              "Because it is the most expensive product in the range to administer",
              "Because the FSCA requires four acknowledgements on partnership products",
              "Because a single agreement covers more than one underlying venture",
            ],
            correct: 0,
            explanation: "Mudarabah carries the loss rule and the target-not-a-promise acknowledgement alongside the fee-on-top and term acknowledgements every EIF agreement has. Each is ticked separately, because one box covering everything acknowledges nothing in particular.",
          },
        ],
      },
      {
        module_index: 4, title: 'The hardest conversation, and the lines you do not cross', estimated_minutes: 16, xp_reward: 70,
        content: `<h3>The explanation that works</h3>
<p>"You put up the capital. A vetted operating partner runs the venture — say a 120-day feedlot cycle. Before a rand is deployed, the split is fixed: 80% of the profit to investors, 20% to them. You get quarterly reporting on how it is going."</p>
<p>Then the part you must not soften: "If the venture makes a loss, that loss falls on the capital. The operating partner does not owe you the shortfall — they lose their share of the profit instead. They put in months of work and get paid nothing. You put in money and it is money you are exposed to. That is what a partnership is, and it is why the return can be higher than the other two."</p>
<h3>Three things clients say, and what to say back</h3>
<p><strong>"So they risk nothing?"</strong> — "They risk being paid nothing for months of work. Each of you loses what you put in. If we made them cover your cash loss too, their contribution would be a guarantee, and a guaranteed partnership is just a loan with another name on it — which is the thing this product exists to avoid."</p>
<p><strong>"What's the worst case?"</strong> — Answer it plainly: "You receive less than you invested, and in the worst case materially less. No product on this platform guarantees a return, and this is the one where that is the structure rather than a disclaimer." A client who cannot hear that answer should not be in this product.</p>
<p><strong>"It's 14.5%, right?"</strong> — "It is a target of 14.5%, drawn from the venture's own projections. It is not a promise and I cannot tell you that you will receive it." Repeat it the same way every time. This is the single sentence most likely to be quoted back at us in a complaint, and the version of it you use is the only version that is safe.</p>
<h3>Suitability, in one line</h3>
<p>Mudarabah suits a client who understands they are a partner in a venture and can afford the outcome if it goes badly. It does not suit a client who is reaching for the biggest number on the page. If you find yourself working hard to make someone comfortable with the loss rule, that is the answer: they are not suited to this product, and the right move is Murabaha or nothing.</p>
${COMMON_COMPLIANCE}`,
        key_points: [
          'Say the loss rule out loud, unsoftened: the loss falls on the capital and the operator forfeits profit rather than covering it',
          '"So they risk nothing?" — they risk months of unpaid work; each partner loses what they contributed',
          'Answer "what is the worst case?" plainly: less than they invested, and in the worst case materially less',
          'Never say "you will get 14.5%" — it is a target drawn from the venture\'s projections and cannot be promised',
          'Working hard to make a client comfortable with the loss rule IS the suitability answer: move them to Murabaha or nothing',
          ...COMMON_COMPLIANCE_POINTS,
        ],
        quiz: [
          {
            question: "A client responds to the loss rule with \"so the operator risks nothing?\" What do you say?",
            options: [
              "\"Correct — the risk sits with you, which is why the target is higher.\"",
              "\"They risk months of unpaid work; each of you loses what you put in.\"",
              "\"They carry a share of the loss, but only once yours is exhausted.\"",
              "\"Their fee is withheld and used to offset part of your loss.\"",
            ],
            correct: 1,
            explanation: "Each partner loses what they contributed: the investor money, the operator months of work paid nothing. Requiring the mudarib to cover a cash loss too would turn their contribution into a guarantee, and a guaranteed partnership is a loan with another name on it.",
          },
          {
            question: "You are working hard to make a client comfortable with the loss rule. What does that tell you?",
            options: [
              "That the explanation needs to be simplified until it lands properly",
              "That they should start with a smaller amount in the same product",
              "That they are not suited to it — move to Murabaha, or to nothing",
              "That a written disclosure will settle the concern satisfactorily",
            ],
            correct: 2,
            explanation: "Effort spent making someone comfortable with the loss rule IS the suitability answer. A client who cannot hear that they may receive materially less than they invested should not be in this product, and a smaller amount or a signature does not fix that.",
          },
          {
            question: "A client says a colleague told them the range is Sharia certified. What do you say?",
            options: [
              "\"That is right — certification is what puts these in their own section.\"",
              "\"Your colleague is mistaken, and I would not rely on anything they said.\"",
              "\"Certification came through recently; the site has not caught up yet.\"",
              "\"It is structured on Islamic principles, but no certificate has been issued.\"",
            ],
            correct: 3,
            explanation: "No certificate has been issued and none is promised by a date. Correct the claim plainly, say that independent review is under way, and invite the client to take their own advice — without disparaging whoever told them otherwise.",
          },
          {
            question: "A client asks whether they can switch their matured Mudarabah into a Murabaha pool instead of taking the cash.",
            options: [
              "Yes — Switch Product is available on all EIF holdings at maturity",
              "Yes, provided the new pool is open on the day the old one matures",
              "No — it settles in cash to the wallet, and they can reinvest from there",
              "No — the proceeds are locked until the next Mudarabah cycle opens",
            ],
            correct: 2,
            explanation: "EIF holdings are payout-only at maturity: each is a concluded contract over a specific venture, so it settles in cash to the wallet. The maturity screen shows Payout All and nothing else. Nothing stops the client investing that cash into a Murabaha pool once it lands.",
          },
        ],
      },
    ],
  },
];

module.exports = { EIF_COURSES };
