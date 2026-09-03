# The Reliability Index

Every constant here is asserted against `MODEL` by
`tests/unit/scoring.test.ts`, so changing one without changing the other fails
the build.

## What the score is

Traditional credit scoring needs a credit history. People without one — young,
recently arrived, previously unbanked — are **thin-file**, and a normal scorecard
has nothing to say about them.

This model reads six months of bank transactions and asks four questions: does
money arrive regularly, does it cover the essentials, are the essentials actually
paid, and is there any cushion? Each is worth points, and the reasons are
returned with the number.

```
reliability_index = clamp(
    income_regularity + income_coverage + essential_consistency + resilience,
    0, 100)
```

| Band   | Range  |
| ------ | ------ |
| LOW    | 0–49   |
| MEDIUM | 50–74  |
| HIGH   | 75–100 |

## Where the numbers come from

We have **Four components - income regularity, income coverage, essential payments consistency and resilience adjustment: each with a weight of 25 points.** We treat all components with equal weight as ranking them by something else would invent a precision or system which we have not derived or proven yet. Resilience
is the only one that can subtract, because it is the only one that registers
things going wrong.

**The shape inside each component is judgement**, reasoned from how affordability
is normally assessed: steady income beats large income, a surplus absorbs shocks,
and paying fixed bills on time is the closest visible stand-in for repayment.

**Nothing is fitted to data** — no repayment outcomes existed to fit against. A
number that looks calibrated gets trusted more than one that looks chosen, so
until this is tested against real outcomes the score should inform a human
decision rather than make one.

## The scoring window

Six calendar months back from `from`, inclusive. `from=2026-02-20` gives
`2025-09-01 … 2026-02-20`: the first day of the month five months before `from`'s
month, through `from` itself. Six month buckets, the last one truncated. All arithmetic is UTC on `YYYY-MM-DD` strings. A booking date has no timezone.

The window must be **completely** covered by synced data or nothing is scored: a
partial window is not a less certain score, it is a wrong one, because unfetched
months are indistinguishable from months with no activity. See
[architecture-design.md](architecture-design.md#45-data-consistency).

---

## Income regularity — 0 to 25 points

```
income_regularity = months_with_income / 6
points            = round(income_regularity × 25)
```

A month has income if it contains at least one **credit that is not an
own-account transfer**. A credit categorised `income` is the stronger signal, but
a bare credit counts too: thin-file applicants are often paid irregularly or by
someone whose payments the provider does not categorise, and treating that as no
income would penalise exactly the population this score exists to serve.

The cost is that a tax refund or a friend repaying a loan counts as a month with
income. That is deliberate — the alternative errs in the more damaging direction
— but it does mean income regularity is closer to "money arrived" than "you were
paid".

**What it rewards: showing up.** Five months of €900 beats one month of €4,500.
For thin-file assessment that is the right instinct — the question is whether
money arrives _regularly_, not whether a lot of it arrived once.

_Example._ Income in five of six months: 5 ÷ 6 = 0.83 → **21 points**.

### Moving your own money is not income

Money landing in your own savings account is a credit, but it is not earnings, so
it does not count as income here.

Otherwise the same €300 counts twice — once as money arriving, and again as money
saved — and anyone who moves cash between their own accounts each month would
outscore someone with identical finances who does not.

The trade-off is that a simpler rule, counting every credit as income, would
score those users higher.

**How a transfer is identified, given no linkage.** The API offers no way to
link the two sides of a transfer — a transaction carries no counterparty, no
transfer id, no reference to another row. That mostly does not matter, because
there is usually no second side: this provider reports an internal transfer as a
single credit on the receiving account.

So identification does not use linkage. It uses two things the row carries on its
own: **where the money landed** — the account's `type`, known because the account
list came from this user — and **how the provider labelled it**, the merchant
category group. Either is enough on its own.

**There is deliberately no fallback that guesses.** Matching two legs by equal
amount and nearby date was tried and removed: it assumes a provider that emits
both sides, which this one does not and a future one might not either — it could
just as well expose a transfer id or a counterparty, and we would be matching on
coincidence instead. The failure is also one-directional: two unrelated payments
of the same amount on the same day would be silently erased from income. Against
this provider it matched nothing, so it was pure risk.

So a transfer is excluded when the data says so, and counted as income when it
does not. The case that falls through is a transfer from the user's own account
**at another bank**: it lands in checking, carries no savings code, and its other
leg is not in our data at all. It counts as income — the one case where this rule
silently overstates, and the reason to widen the input rather than the model.

---

## Income coverage ratio — 0 to 25 points

```
income_coverage_ratio = total_income / total_essential_expenses
```

Piecewise-linear between these points, clamped at both ends:

| Coverage | Points | Why here                                                      |
| -------- | ------ | ------------------------------------------------------------- |
| 0.0×     | 0      | No income against essentials.                                 |
| 0.8×     | 6      | Structurally short every month. Some income still beats none. |
| 1.0×     | 12     | **Break-even earns about half, not full marks.**              |
| 1.25×    | 18     | A real buffer starts. Steepest part of the curve.             |
| 1.5×     | 21     | Comfortable.                                                  |
| 2.0×     | 24     | Diminishing returns begin.                                    |
| 3.0×+    | 25     | Saturated.                                                    |

**Why break-even is only half marks.** Someone earning exactly what their
essentials cost has nothing left when a paycheque is late or the boiler breaks.
Break-even is the edge of resilience, not resilience.

**Why it flattens above 2×.** The gap between a 3× and a 5× earner says little
about reliability, mostly that they are not thin-file. Rewarding it further would
turn the component into an income-level proxy.

_Example._ €2,820 against €2,000 essentials = 1.41×, between the 1.25× and 1.5×
breakpoints: 18 + 3 × (1.41−1.25)/(1.5−1.25) = **19.9 → 20 points**.

**Zero essential expenses** makes the ratio undefined, not infinite. Award the
1.0× value (12) and say so in a driver. A data gap must never read as a perfect
score.

---

## Essential payments consistency — 0 to 25 points

```
essential_payments_consistency =
  (essential category-months present) / (6 × number of essential categories)
points = round(consistency × 25)
```

A category-month counts if at least one transaction in that essential category
falls in that month.

The essential list comes from the merchant-category dictionary **at the version
the covering sync recorded**, never hardcoded and never fetched at scoring time.
An upstream category addition would otherwise change the denominator and shift
every score silently.

**What pinning does and does not mean.** The dictionary is one global artefact —
a code-to-group mapping, versioned whenever its content changes, with no date
range attached to any version. So a pin records _which mapping produced this
score_, which is what keeps the score reproducible. It is **not** a claim that
those categories were the ones in force across the transaction window; nothing
upstream expresses that, and a code's group does not depend on when it was
fetched.

That is also why a missing pin is not a refusal. If the covering sync recorded no
version — a first sync whose category refresh failed leaves one behind — scoring
uses the current dictionary and says so in `data_quality`, rather than refusing
while a perfectly usable mapping sits in the database. Only a service that has
never fetched a dictionary at all cannot score.

_Example._ Four essential categories over six months = 24 possible
category-months. Rent and groceries appear in all six, utilities in five,
transport in four: 21 of 24 = 0.875 → **22 points**.

**This is the least fair component.** The denominator assumes every essential
category applies to every applicant. Someone with no car has no fuel transactions
and loses six category-months for a cost they do not have.

---

## Resilience adjustments — −20 to +25 points

Is there a cushion, and are there signs of strain? The four signals are summed,
then clamped.

| Signal                | Range | How it is measured                                       | Why that shape                                                                                                                                 |
| --------------------- | ----- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Savings               | 0…+25 | Net into savings ÷ total income; 15% earns full credit   | A rate, not an amount — €200 on €1,200 income means more than €200 on €6,000. Net, because money moved in and straight back out is not saving. |
| Negative balance days | 0…−10 | Estimated days with a negative balance; 30+ saturates    | 30 days is a month spent overdrawn, which is a pattern. One tight week before payday is not.                                                   |
| Late fees             | 0…−5  | −1.25 per `fees` transaction; 4+ saturates               | A fee is the visible end of a shortfall the other signals have usually counted already.                                                        |
| High-risk spend       | 0…−5  | Share of spend in `high_risk` categories; 20%+ saturates | Small, because the category list is inherited from upstream rather than chosen — see _Bias_.                                                   |

The penalties total −20 against 100 points of positives. The largest of them is
estimated rather than observed, and an inferred signal should not move a score as
far as one we can count.

### Why the negative-balance figure is an estimate

The Banking API gives one _current_ balance and a transaction history — never a
balance per day. The daily series is reconstructed backwards from that single
figure, anchored at the end of the window.

Anchoring there is an assumption, not a fact: the reported balance does not
reconcile with the transactions the API publishes, so rolling it back over later
movement makes the series worse rather than better.

---

## Currency — EUR only, and foreign rows are dropped

The exercise is single-currency and FX conversion is out of scope, so the service
does none. What it must not do is combine currencies as though the question did
not arise: upstream types `currency` as a bare string with no enum, so a
foreign-currency row is contractually possible even though none has been
observed.

Summing one in is not a small error. A single USD credit added to an otherwise
EUR history moves `income_coverage_ratio` from 1.11 to 2.04 — the headline index
barely twitches, because component B saturates, so the corruption hides in a
metric while the score looks stable. And the response labels every score `"EUR"`.

**The policy: drop at ingest, count, and carry on.**

- A **transaction** in another currency is not stored. The rest of its page is,
  so an otherwise-EUR account keeps its history and stays scoreable.
- An **account** in another currency is dropped whole and never walked —
  including its balance, which would otherwise anchor the negative-balance
  reconstruction of a EUR series.
- Every drop increments `sync.non_eur_skipped{kind,currency}` and is named in the
  sync response `warnings`, so the caller sees what was discarded rather than
  inferring it from a total that does not add up.
- Nothing is converted, and nothing is combined. A dropped row is absent from the
  score, not approximated in it.

The consequence to know about: an account that flips to a foreign currency after
having been synced in EUR stops being walked, so it falls out of coverage and
scoring **refuses** for that user until it is resolved. That is deliberate —
refusing is the loud failure; scoring the remainder as though the account were
complete would be the quiet one.

---

## `good_months` — a definition nobody gave

The response contract carries `good_months` without anywhere defining what a good
month is. Defined here as a month with **all three** of: at least one income
transaction, at least one essential-category payment, and no fee event. That is
the plain-language reading of "a month that went well", and it reuses the income
and essential-payment signals the score already establishes rather than inventing
a fourth notion of a month.

**Reported, never scored.**

## Drivers

`drivers` is what an analyst reads instead of the code.

- One entry per component that materially moved the score.
- State the evidence, not the arithmetic: `"Income present in 5/6 months"`, not
  `"A = 20.83"`.
- Include the penalties. A score is not explained if only the good news appears.
- Never phrase a driver as a judgement about a person: `"63 days with a negative
running balance"`, not `"poor money management"`.
- **Say when the model is guessing.** Where a component cannot tell "did not
  happen" from "was not visible", the driver must say so rather than quietly
  deduct.

## Reproducibility

Any change to a constant or to the logic becomes a **new model version** — a new
file, kept forever, never an edit to the old one. The category dictionary is
versioned the same way, because upstream can regroup a code at any time. So a
score records which model and which dictionary produced it, and can be re-derived
exactly. The storage mechanics are in
[architecture-design.md](architecture-design.md#44-data-model).

That turns "why did this score change?" into a lookup:

| Observation                                      | Conclusion                                                  |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Same `input_hash`, same version, different score | A bug. The model is not deterministic.                      |
| Same `input_hash`, different version             | An intended model change; see the changelog.                |
| Different `input_hash`                           | The data moved — a partial run, or backdated late arrivals. |

---

## Limitations

**Six months is short.** Someone made redundant in month 1 who found work in
month 3 shows four months of income and a coverage dip. Someone made redundant in
month 5 shows five months and looks better — despite being the one currently
without a job.

**No trend term.** Improving and deteriorating finances with identical totals
score identically, though they mean opposite things.

> |         | Sep   | Oct   | Nov   | Dec   | Jan   | Feb   | Total  |
> | ------- | ----- | ----- | ----- | ----- | ----- | ----- | ------ |
> | **Ama** | 1,000 | 1,200 | 1,600 | 2,400 | 2,800 | 3,000 | 12,000 |
> | **Ben** | 3,000 | 2,800 | 2,400 | 1,600 | 1,200 | 1,000 | 12,000 |
>
> Identical totals, months-with-income and coverage ratio — therefore identical
> scores. Ama has tripled her income; Ben has lost two thirds of his. A lender
> would very much like to tell them apart. Adding a trend term is the single most
> valuable improvement available, and is out of scope only because the component
> formulas are fixed for v1.

**Categorisation is inherited, not verified.** If upstream relabels supermarket
delivery from `groceries` to `retail`, essential payments consistency drops for
thousands of users and nothing here notices.

**Absence is treated as evidence.** A missing category-month scores the same
whether the applicant paid in cash, paid through a partner's account, or genuinely
missed the payment.

**One bank is not all banks.** The Banking API returns every account a user
holds _with this provider_ — but nothing about accounts held elsewhere. Rent paid
from an account at another bank is invisible, and reads as rent not paid.

---

## Bias and fairness

This is a credit-adjacent score about people whose thin file is often itself a
consequence of being young, a recent migrant, or previously unbanked.

**Every failure mode below has the same shape: missing data scoring as bad
data.**

- **Cash-based lives score lower.** Cash income and cash rent are invisible to
  the API, so they read as absence in both income regularity and essential
  payments consistency — hardest on exactly the population the product exists to
  serve.
- **Essential payments consistency assumes a lifestyle.** Its denominator counts
  every essential category against every applicant. Someone who cycles to work has no
  fuel transactions: six missing category-months, around five points off, for a
  cost they do not have.
- **A thin file is punished twice.** Someone paid partly in cash, whose flatmate
  pays the energy bill, loses points for **fewer visible income months** _and_
  again for **fewer visible category-months** — the same underlying fact counted
  twice, that less of their life passes through this one account.
- **Category dictionaries carry their own bias.** If upstream marks remittance
  services `high_risk`, migrant workers sending money home are penalised for
  something that correlates strongly with national origin and weakly with
  default. Nobody wrote that rule; it was inherited. The `high_risk` list needs
  review as a policy artefact, not silent trust as a data feed.

### Measuring whether it is happening

The question is whether each part of the score measures the **person**, or just
**how much of their life we can see**. Every score is stored with its component
breakdown, so this is a query, not a research project.

**Group users by how much we can see** — transactions in the window, number of
accounts, how long they have banked here. Bottom quartile against top. We do not
hold protected characteristics and should not, but cash-paid workers, recent
arrivals and the previously unbanked cluster in the bottom group, which is what
makes visibility a usable stand-in.

**Then compare how often each component scores zero in each group.** Zero is the
sharpest test, because it is the one value where "it did not happen" and "we
could not see it" look identical.

> Essential payments consistency scores zero for **15%** of low-visibility users
> against **4%** of high — **3.75×**. It is tracking what we can see more than
> what the applicant did.

Compare ratios, not percentage-point gaps: base rates differ a lot between
components, since plenty of people genuinely save nothing.

**Above 2×, investigate.** Not a failure in itself — someone with 45 transactions
really does have less activity than someone with 380 — but it names the component
where visibility rather than behaviour is driving the score. Run it on a
schedule; bias arrives through drift long after a model is reviewed.

## Mitigations

None are implemented in v1, which fixes the component formulas. Each is specific.

1. **Score only the categories the applicant demonstrably has**, with a floor of
   two or three so the denominator cannot collapse to one easy category. The
   cyclist stops being penalised for petrol; someone who paid rent for three
   months and stopped is still penalised, correctly.
2. **Report confidence beside the score.** `data_quality` already ships; extend
   it with how much of the applicant's finances these accounts probably cover.
   Two people can both score 48: one where we saw their whole financial life,
   one where we saw a single account with no rent leaving it. The second 48 is
   the weaker of the two, and a reviewer should be able to tell them apart.
3. **Say when points were lost to something missing.** If no transport
   transactions turned up all window, the driver should say so — the applicant
   may simply have no transport costs. The score is the same either way, but a
   stated gap can be questioned, while a silent one just becomes a decision.
4. **Collect more data rather than adjusting the formula.** Most of the
   unfairness comes from seeing too little of someone, so ask applicants to
   connect their other accounts, and let them mark a category as not applicable
   with the claim recorded. That treats the cause; changing weights only
   compensates for it.
5. **Add a trend term.** Compare the window's two halves and return the
   direction; only after calibration, a small bounded adjustment.
6. **Route cash-heavy profiles to review.** Income visible in few months but
   essentials paid regularly is more consistent with cash income than with
   unreliability.
7. **Review `high_risk` as policy**, owned by a person, each category justified
   in terms of credit risk rather than inherited.

---

## Changelog

| Version | Change                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------- |
| 1       | Initial model: four components at 25 points each, with the coverage curve and resilience sub-mappings chosen above. |
