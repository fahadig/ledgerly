/**
 * The codified accounting rule-set.
 *
 * WHAT THIS IS: a curated, citable decision aid covering the transaction types
 * a mid-market group actually meets. Each rule states the requirement in plain
 * English, the booking treatment, a chart-agnostic entry skeleton, and where
 * IFRS and US GAAP diverge.
 *
 * WHAT THIS IS NOT: a reproduction of IFRS or the FASB Codification. Those run
 * to tens of thousands of copyrighted pages. Nothing here replaces reading the
 * standard or the judgement of a qualified accountant, and the UI says so
 * wherever a rule is surfaced.
 *
 * It is data on purpose — an accountant can add or amend rules through the
 * Standards screen without touching code, and every row keeps its citation so
 * an auditor can follow the reasoning years later.
 */

import type { Framework, StandardTopic } from '@/db/schema';

export interface EntryTemplateLine {
  side: 'DEBIT' | 'CREDIT';
  /** An account subtype, not an id, so the template maps onto any chart. */
  subtype: string;
  note: string;
}

export interface StandardRule {
  framework: Framework;
  reference: string;
  topic: StandardTopic;
  title: string;
  requirement: string;
  treatment: string;
  entryTemplate?: EntryTemplateLine[];
  keywords: string[];
  policyKey?: string;
  divergenceNote?: string;
  disclosure?: string;
}

// ─────────────────────────── IFRS ────────────────────────────────────

const IFRS: StandardRule[] = [
  {
    framework: 'IFRS',
    reference: 'IFRS 15.31',
    topic: 'REVENUE',
    title: 'Revenue recognised when control transfers',
    requirement:
      'Recognise revenue when (or as) the entity satisfies a performance obligation by transferring the promised good or service — that is, when the customer obtains control.',
    treatment:
      'On transfer of control, debit Accounts Receivable (or Contract Asset if the right to consideration is conditional) and credit Revenue. Invoicing alone is not the trigger; control is.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'ACCOUNTS_RECEIVABLE', note: 'Amount the entity is entitled to' },
      { side: 'CREDIT', subtype: 'INCOME', note: 'Revenue for the satisfied obligation' },
    ],
    keywords: ['revenue', 'sale', 'invoice', 'delivered', 'shipped', 'performance obligation', 'service completed'],
    divergenceNote: 'Substantially converged with ASC 606 — the five-step model is the same.',
    disclosure: 'Disaggregation of revenue, contract balances, and remaining performance obligations.',
  },
  {
    framework: 'IFRS',
    reference: 'IFRS 15.106',
    topic: 'REVENUE',
    title: 'Advance from customer is a contract liability',
    requirement:
      'Cash received before the performance obligation is satisfied is a contract liability, not revenue.',
    treatment: 'Debit Bank, credit Contract Liability (deferred revenue). Release to revenue as the obligation is satisfied.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'BANK', note: 'Cash received in advance' },
      { side: 'CREDIT', subtype: 'OTHER_CURRENT_LIABILITY', note: 'Contract liability / deferred revenue' },
    ],
    keywords: ['advance', 'deposit', 'prepayment', 'upfront', 'retainer', 'deferred revenue', 'unearned'],
    divergenceNote: 'Same treatment under ASC 606-10-45-2.',
  },
  {
    framework: 'IFRS',
    reference: 'IFRS 15.B34',
    topic: 'REVENUE',
    title: 'Principal versus agent',
    requirement:
      'An entity that controls the good or service before transfer is a principal and recognises gross revenue; an agent recognises only its fee or commission.',
    treatment: 'If acting as agent, credit revenue for the net commission only — do not gross up sales and cost of sales.',
    keywords: ['agent', 'principal', 'commission', 'marketplace', 'reseller', 'gross', 'net', 'platform fee'],
    divergenceNote: 'Aligned with ASC 606-10-55-36.',
  },
  {
    framework: 'IFRS',
    reference: 'IFRS 16.22',
    topic: 'LEASES',
    title: 'Lessee recognises a right-of-use asset and lease liability',
    requirement:
      'At the commencement date a lessee recognises a right-of-use asset and a lease liability measured at the present value of unpaid lease payments.',
    treatment:
      'Debit Right-of-use Asset, credit Lease Liability. Thereafter, depreciate the asset and split each payment between interest expense and principal. Rent expense is NOT the correct treatment for an in-scope lease.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'FIXED_ASSET', note: 'Right-of-use asset at present value of lease payments' },
      { side: 'CREDIT', subtype: 'LONG_TERM_LIABILITY', note: 'Lease liability' },
    ],
    keywords: ['lease', 'rent agreement', 'tenancy', 'right of use', 'rou', 'lessee', 'office lease', 'vehicle lease'],
    divergenceNote:
      'IFRS 16 uses a single lessee model — every lease produces depreciation plus interest. ASC 842 splits leases into finance and operating; an operating lease under US GAAP produces a single straight-line lease cost.',
    disclosure: 'Maturity analysis of lease liabilities and ROU asset movements by class.',
  },
  {
    framework: 'IFRS',
    reference: 'IFRS 16.6',
    topic: 'LEASES',
    title: 'Short-term and low-value lease exemption',
    requirement:
      'A lessee may elect not to recognise a right-of-use asset for leases of 12 months or less, or where the underlying asset is of low value.',
    treatment: 'Recognise the payments as an expense on a straight-line basis. Debit Rent/Lease Expense, credit Bank or Accounts Payable.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'EXPENSE', note: 'Lease expense, straight-line' },
      { side: 'CREDIT', subtype: 'BANK', note: 'Payment' },
    ],
    keywords: ['short term lease', 'monthly rent', 'office rent', 'low value', 'twelve months'],
    policyKey: 'short_term_lease_exemption',
  },
  {
    framework: 'IFRS',
    reference: 'IAS 2.9',
    topic: 'INVENTORY',
    title: 'Inventory at the lower of cost and net realisable value',
    requirement: 'Inventories are measured at the lower of cost and net realisable value.',
    treatment: 'When NRV falls below cost, debit Cost of Sales (write-down) and credit Inventory. A later recovery is reversed, limited to the original write-down.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'COST_OF_GOODS_SOLD', note: 'Write-down to net realisable value' },
      { side: 'CREDIT', subtype: 'OTHER_CURRENT_ASSET', note: 'Inventory' },
    ],
    keywords: ['inventory', 'stock', 'write down', 'obsolete', 'nrv', 'net realisable'],
    divergenceNote:
      'IFRS permits reversal of an inventory write-down when NRV recovers. Under ASC 330 a write-down of inventory creates a new cost basis and is not reversed.',
  },
  {
    framework: 'IFRS',
    reference: 'IAS 2.25',
    topic: 'INVENTORY',
    title: 'Cost formula — FIFO or weighted average only',
    requirement: 'The cost of inventories is assigned using FIFO or weighted average cost. LIFO is prohibited.',
    treatment: 'Apply the same formula to all inventories of a similar nature and use.',
    keywords: ['fifo', 'lifo', 'weighted average', 'cost formula', 'inventory valuation'],
    policyKey: 'inventory_cost_formula',
    divergenceNote: 'ASC 330 permits LIFO. A US subsidiary on LIFO must be restated to FIFO or weighted average for IFRS group reporting.',
  },
  {
    framework: 'IFRS',
    reference: 'IAS 16.16',
    topic: 'PPE',
    title: 'Property, plant and equipment measured initially at cost',
    requirement:
      'Cost comprises the purchase price, directly attributable costs of bringing the asset to its location and condition, and the initial estimate of dismantling costs.',
    treatment:
      'Capitalise delivery, installation and testing into the asset. Debit the fixed-asset account, credit Bank or Accounts Payable. Do not expense these to repairs.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'FIXED_ASSET', note: 'Purchase price plus directly attributable costs' },
      { side: 'CREDIT', subtype: 'ACCOUNTS_PAYABLE', note: 'Supplier' },
    ],
    keywords: ['equipment', 'machine', 'laptop', 'computer', 'vehicle', 'furniture', 'installation', 'capital', 'asset purchase'],
    divergenceNote: 'Initial measurement is the same under ASC 360.',
  },
  {
    framework: 'IFRS',
    reference: 'IAS 16.31',
    topic: 'PPE',
    title: 'Revaluation model permitted',
    requirement:
      'After recognition an entity may carry PPE at a revalued amount, being fair value at the revaluation date less subsequent depreciation.',
    treatment:
      'An increase goes to Other Comprehensive Income and accumulates in a revaluation surplus within equity, unless it reverses a previous decrease charged to profit or loss.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'FIXED_ASSET', note: 'Uplift to fair value' },
      { side: 'CREDIT', subtype: 'EQUITY', note: 'Revaluation surplus (OCI)' },
    ],
    keywords: ['revaluation', 'fair value', 'uplift', 'revalue property'],
    policyKey: 'ppe_measurement',
    divergenceNote: 'US GAAP does not permit revaluation of PPE — ASC 360 requires the historical cost model.',
  },
  {
    framework: 'IFRS',
    reference: 'IAS 16.50',
    topic: 'PPE',
    title: 'Depreciate over useful life',
    requirement: 'The depreciable amount of an asset is allocated on a systematic basis over its useful life.',
    treatment: 'Debit Depreciation Expense, credit Accumulated Depreciation. Review useful life and residual value at least annually.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'EXPENSE', note: 'Depreciation expense for the period' },
      { side: 'CREDIT', subtype: 'FIXED_ASSET', note: 'Accumulated depreciation' },
    ],
    keywords: ['depreciation', 'amortise asset', 'useful life', 'wear and tear'],
  },
  {
    framework: 'IFRS',
    reference: 'IAS 38.54',
    topic: 'INTANGIBLES',
    title: 'Research costs are expensed',
    requirement: 'Expenditure on research (or the research phase of an internal project) is recognised as an expense when incurred.',
    treatment: 'Debit Research Expense, credit Bank or Accounts Payable.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'EXPENSE', note: 'Research expenditure' },
      { side: 'CREDIT', subtype: 'BANK', note: 'Payment' },
    ],
    keywords: ['research', 'r&d', 'investigation', 'feasibility study'],
  },
  {
    framework: 'IFRS',
    reference: 'IAS 38.57',
    topic: 'INTANGIBLES',
    title: 'Development costs capitalised once six criteria are met',
    requirement:
      'Development expenditure is capitalised only when the entity can demonstrate all six criteria: technical feasibility, intention to complete, ability to use or sell, probable future economic benefits, availability of resources, and reliable measurement of the expenditure.',
    treatment:
      'Once the criteria are met, debit Intangible Asset — Development Costs and credit Bank or Payroll. Expenditure before that date stays in profit or loss and is never reinstated.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'OTHER_ASSET', note: 'Capitalised development costs' },
      { side: 'CREDIT', subtype: 'BANK', note: 'Costs incurred after criteria met' },
    ],
    keywords: ['development', 'software development', 'product build', 'engineering cost', 'capitalise development'],
    policyKey: 'development_costs',
    divergenceNote:
      'This is a headline divergence. US GAAP (ASC 730) requires R&D to be expensed as incurred, with a narrow exception for internal-use software (ASC 350-40) and software to be sold (ASC 985-20).',
    disclosure: 'Reconciliation of carrying amount, amortisation method and useful life for each class of intangible.',
  },
  {
    framework: 'IFRS',
    reference: 'IAS 36.59',
    topic: 'IMPAIRMENT',
    title: 'Impairment loss when carrying amount exceeds recoverable amount',
    requirement:
      'An impairment loss is recognised when the carrying amount exceeds the recoverable amount — the higher of fair value less costs of disposal and value in use.',
    treatment: 'Debit Impairment Loss, credit the asset (or its accumulated impairment).',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'EXPENSE', note: 'Impairment loss' },
      { side: 'CREDIT', subtype: 'FIXED_ASSET', note: 'Accumulated impairment' },
    ],
    keywords: ['impairment', 'write off asset', 'recoverable amount', 'value in use'],
    divergenceNote:
      'IFRS uses a one-step discounted test. ASC 360 uses a two-step test starting with undiscounted cash flows, so an asset can fail under IFRS while passing under US GAAP.',
  },
  {
    framework: 'IFRS',
    reference: 'IAS 36.114',
    topic: 'IMPAIRMENT',
    title: 'Impairment reversal required when indicators reverse',
    requirement:
      'An impairment loss recognised in prior periods for an asset other than goodwill is reversed if, and only if, the estimates used to determine recoverable amount have changed.',
    treatment: 'Debit the asset, credit Impairment Reversal in profit or loss — capped at the carrying amount that would have existed had no impairment been recognised.',
    keywords: ['impairment reversal', 'recovery', 'write back'],
    divergenceNote: 'ASC 360-10-35-20 PROHIBITS reversal. This is a hard divergence — a group reporting under both needs a restatement adjustment.',
  },
  {
    framework: 'IFRS',
    reference: 'IAS 37.14',
    topic: 'PROVISIONS',
    title: 'Provision recognised when outflow is probable and estimable',
    requirement:
      'A provision is recognised when there is a present obligation from a past event, an outflow of resources is probable, and a reliable estimate can be made.',
    treatment: 'Debit the related Expense, credit Provision (liability). Remeasure at each reporting date.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'EXPENSE', note: 'Expense giving rise to the obligation' },
      { side: 'CREDIT', subtype: 'OTHER_CURRENT_LIABILITY', note: 'Provision' },
    ],
    keywords: ['provision', 'legal claim', 'warranty', 'restructuring', 'onerous contract', 'accrual for dispute'],
    divergenceNote:
      'IFRS reads "probable" as more likely than not (>50%). ASC 450 reads "probable" as a considerably higher threshold, so US GAAP recognises fewer provisions. Where a range is equally likely, IFRS uses the midpoint and ASC 450 uses the low end.',
    disclosure: 'Nature, expected timing, uncertainties and movements in each class of provision.',
  },
  {
    framework: 'IFRS',
    reference: 'IAS 37.86',
    topic: 'PROVISIONS',
    title: 'Contingent liability is disclosed, not recognised',
    requirement: 'A contingent liability is not recognised; it is disclosed unless the possibility of outflow is remote.',
    treatment: 'Post no journal entry. Record a note to the financial statements.',
    keywords: ['contingent', 'possible claim', 'guarantee given', 'pending litigation'],
  },
  {
    framework: 'IFRS',
    reference: 'IAS 19.11',
    topic: 'EMPLOYEE_BENEFITS',
    title: 'Short-term employee benefits accrued as service is rendered',
    requirement:
      'The undiscounted amount of short-term benefits expected to be paid for service already rendered is recognised as a liability and an expense.',
    treatment:
      'Debit Salaries & Wages for the gross amount, credit Payroll Liabilities for tax and social security withheld, and credit Bank for net pay. Unused paid leave earned is accrued.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'EXPENSE', note: 'Gross salaries and wages' },
      { side: 'CREDIT', subtype: 'OTHER_CURRENT_LIABILITY', note: 'Tax and social security withheld' },
      { side: 'CREDIT', subtype: 'BANK', note: 'Net pay transferred' },
    ],
    keywords: ['payroll', 'salary', 'salaries', 'wages', 'bonus', 'leave accrual', 'staff cost'],
  },
  {
    framework: 'IFRS',
    reference: 'IAS 12.15',
    topic: 'INCOME_TAX',
    title: 'Deferred tax on temporary differences',
    requirement:
      'A deferred tax liability is recognised for all taxable temporary differences; a deferred tax asset for deductible differences to the extent future taxable profit is probable.',
    treatment: 'Debit or credit Deferred Tax Expense against a Deferred Tax Asset or Liability. Measure using rates enacted or substantively enacted by the reporting date.',
    keywords: ['deferred tax', 'temporary difference', 'tax provision', 'income tax'],
    divergenceNote:
      'IFRS requires "substantively enacted" rates; ASC 740 requires rates that are fully enacted. IFRS presents all deferred tax as non-current; ASC 740 also requires non-current classification since ASU 2015-17.',
  },
  {
    framework: 'IFRS',
    reference: 'IAS 21.21',
    topic: 'FOREIGN_CURRENCY',
    title: 'Foreign currency transaction recorded at the spot rate',
    requirement: 'A foreign currency transaction is recorded on initial recognition at the spot exchange rate at the transaction date.',
    treatment: 'Translate the invoice at the transaction-date rate into the functional currency and post normally.',
    keywords: ['foreign currency', 'fx', 'exchange rate', 'usd invoice', 'eur', 'spot rate'],
    divergenceNote: 'Aligned with ASC 830-20-30.',
  },
  {
    framework: 'IFRS',
    reference: 'IAS 21.23',
    topic: 'FOREIGN_CURRENCY',
    title: 'Monetary items retranslated at each reporting date',
    requirement:
      'At each reporting date, foreign-currency monetary items are retranslated at the closing rate; non-monetary items at historical cost stay at the historical rate.',
    treatment: 'Debit or credit Foreign Exchange Gain/Loss in profit or loss against the receivable, payable or bank balance.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'ACCOUNTS_RECEIVABLE', note: 'Retranslation of monetary item (or credit if a loss)' },
      { side: 'CREDIT', subtype: 'OTHER_INCOME', note: 'Foreign exchange gain' },
    ],
    keywords: ['revaluation of balances', 'fx gain', 'fx loss', 'retranslation', 'closing rate', 'unrealised exchange'],
  },
  {
    framework: 'IFRS',
    reference: 'IAS 21.39',
    topic: 'FOREIGN_CURRENCY',
    title: 'Translation of a foreign operation for consolidation',
    requirement:
      'Assets and liabilities are translated at the closing rate, income and expenses at the rate at the dates of the transactions (an average is usually acceptable), and the resulting differences are recognised in other comprehensive income.',
    treatment: 'Accumulate the difference in a Foreign Currency Translation Reserve within equity. It is reclassified to profit or loss on disposal of the operation.',
    keywords: ['translation', 'consolidation currency', 'subsidiary in foreign currency', 'ctr', 'translation reserve'],
    divergenceNote: 'Mechanically the same as ASC 830-30, where the reserve is called the Cumulative Translation Adjustment (CTA).',
  },
  {
    framework: 'IFRS',
    reference: 'IAS 23.8',
    topic: 'BORROWING_COSTS',
    title: 'Borrowing costs on qualifying assets are capitalised',
    requirement:
      'Borrowing costs directly attributable to the acquisition, construction or production of a qualifying asset form part of the cost of that asset.',
    treatment: 'Debit the asset under construction rather than Interest Expense, for the period in which the asset is being prepared for use.',
    keywords: ['interest', 'borrowing cost', 'construction', 'qualifying asset', 'capitalise interest'],
    divergenceNote: 'ASC 835-20 is broadly similar but computes the capitalisation rate differently and excludes certain assets.',
  },
  {
    framework: 'IFRS',
    reference: 'IFRS 9.5.5.1',
    topic: 'FINANCIAL_INSTRUMENTS',
    title: 'Expected credit loss allowance on receivables',
    requirement: 'A loss allowance for expected credit losses is recognised on financial assets measured at amortised cost, including trade receivables.',
    treatment:
      'For trade receivables, apply the simplified approach: lifetime expected losses from a provision matrix. Debit Impairment Loss on Receivables, credit Allowance for Doubtful Debts.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'EXPENSE', note: 'Expected credit loss' },
      { side: 'CREDIT', subtype: 'ACCOUNTS_RECEIVABLE', note: 'Allowance for doubtful debts' },
    ],
    keywords: ['bad debt', 'doubtful', 'ecl', 'allowance', 'provision for receivables', 'write off customer'],
    divergenceNote: 'ASC 326 (CECL) is similar in direction but measures lifetime losses on all in-scope assets from day one, without the IFRS 9 stage model.',
  },
  {
    framework: 'IFRS',
    reference: 'IFRS 10.B86',
    topic: 'CONSOLIDATION',
    title: 'Consolidation procedures — eliminate intragroup items in full',
    requirement:
      'Combine like items of assets, liabilities, equity, income and expenses; offset the parent’s investment in each subsidiary against the parent’s portion of equity; and eliminate intragroup assets, liabilities, equity, income, expenses and cash flows in full.',
    treatment:
      'Eliminate intercompany receivables against payables, intercompany sales against purchases, and unrealised profit remaining in inventory. Eliminations are posted to a separate consolidation layer, never to the subsidiaries’ own books.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'ACCOUNTS_PAYABLE', note: 'Intercompany payable in the buying entity' },
      { side: 'CREDIT', subtype: 'ACCOUNTS_RECEIVABLE', note: 'Matching receivable in the selling entity' },
    ],
    keywords: ['consolidation', 'intercompany', 'elimination', 'group', 'subsidiary', 'intragroup'],
    divergenceNote: 'ASC 810 requires the same eliminations; the control model differs in detail (IFRS 10 control vs the US VIE model).',
  },
  {
    framework: 'IFRS',
    reference: 'IFRS 10.22',
    topic: 'CONSOLIDATION',
    title: 'Non-controlling interests presented within equity',
    requirement:
      'Non-controlling interests are presented in the consolidated statement of financial position within equity, separately from the equity of the owners of the parent.',
    treatment: 'Allocate profit or loss and each component of OCI to the owners of the parent and to the NCI in proportion to their holdings, even if that makes the NCI balance negative.',
    keywords: ['nci', 'minority interest', 'non-controlling', 'ownership percentage'],
    divergenceNote: 'Same presentation under ASC 810-10-45-16.',
  },
  {
    framework: 'IFRS',
    reference: 'IFRS 3.32',
    topic: 'CONSOLIDATION',
    title: 'Goodwill on acquisition',
    requirement:
      'Goodwill is the excess of consideration transferred plus non-controlling interests plus any previously held interest, over the net identifiable assets acquired.',
    treatment: 'Recognise goodwill as an asset. Do not amortise it; test annually for impairment.',
    keywords: ['goodwill', 'acquisition', 'business combination', 'purchase price allocation'],
    divergenceNote:
      'IFRS prohibits goodwill amortisation for all entities. US GAAP allows private companies an accounting alternative to amortise goodwill over up to 10 years (ASC 350-20).',
  },
  {
    framework: 'IFRS',
    reference: 'IAS 24.18',
    topic: 'RELATED_PARTIES',
    title: 'Related party transactions disclosed',
    requirement:
      'An entity discloses the nature of the related party relationship, the amount of the transactions, outstanding balances and any provisions against them.',
    treatment: 'No special posting; tag the counterparty as related so the disclosure report can pick it up.',
    keywords: ['related party', 'director loan', 'shareholder', 'associate', 'key management'],
  },
  {
    framework: 'IFRS',
    reference: 'IAS 20.7',
    topic: 'GOVERNMENT_GRANTS',
    title: 'Government grants recognised as the related costs are expensed',
    requirement:
      'Grants are recognised only when there is reasonable assurance the conditions will be met and the grant will be received, and are matched to the costs they compensate.',
    treatment: 'Recognise as deferred income and release to profit or loss over the periods of the related costs, or deduct from the carrying amount of the asset.',
    keywords: ['grant', 'subsidy', 'government support', 'incentive'],
    policyKey: 'grant_presentation',
  },
  {
    framework: 'IFRS',
    reference: 'IAS 38.8 / IFRIC (June 2019)',
    topic: 'CRYPTO_ASSETS',
    title: 'Cryptocurrency holdings are intangible assets, or inventory for broker-traders',
    requirement:
      'A holding of cryptocurrency meets the definition of an intangible asset under IAS 38. It is accounted for as inventory under IAS 2 only when held for sale in the ordinary course of business by a broker-trader.',
    treatment:
      'Under IAS 38 use the cost model (or revaluation model if an active market exists). Increases in value are NOT recognised in profit or loss under the cost model; decreases are impairment losses.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'OTHER_ASSET', note: 'Crypto asset at cost' },
      { side: 'CREDIT', subtype: 'BANK', note: 'Purchase consideration' },
    ],
    keywords: ['crypto', 'bitcoin', 'ethereum', 'token', 'wallet', 'digital asset', 'stablecoin', 'usdt'],
    policyKey: 'crypto_classification',
    divergenceNote:
      'US GAAP diverged in 2023: ASC 350-60 (ASU 2023-08) requires in-scope crypto assets to be measured at FAIR VALUE with changes in profit or loss. IFRS has no equivalent — a group reporting under both will carry the same token at two different amounts.',
    disclosure: 'Nature and quantity of holdings, custody arrangements, and measurement basis.',
  },
  {
    framework: 'IFRS',
    reference: 'IAS 1.54',
    topic: 'PRESENTATION',
    title: 'Minimum line items on the statement of financial position',
    requirement:
      'The statement of financial position includes, at minimum, line items for PPE, intangibles, financial assets, inventories, trade receivables, cash, trade payables, provisions, financial liabilities, tax balances, non-controlling interests and issued capital.',
    treatment: 'Chart-of-accounts design should roll up cleanly onto these captions.',
    keywords: ['presentation', 'balance sheet', 'statement of financial position', 'line items'],
  },
];

// ─────────────────────────── US GAAP ─────────────────────────────────

const US_GAAP: StandardRule[] = [
  {
    framework: 'US_GAAP',
    reference: 'ASC 606-10-25-30',
    topic: 'REVENUE',
    title: 'Revenue recognised when control transfers',
    requirement:
      'An entity recognises revenue when it satisfies a performance obligation by transferring control of a good or service to the customer.',
    treatment: 'Debit Accounts Receivable (or Contract Asset), credit Revenue on transfer of control.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'ACCOUNTS_RECEIVABLE', note: 'Amount the entity is entitled to' },
      { side: 'CREDIT', subtype: 'INCOME', note: 'Revenue for the satisfied obligation' },
    ],
    keywords: ['revenue', 'sale', 'invoice', 'delivered', 'shipped', 'performance obligation', 'service completed'],
    divergenceNote: 'Substantially converged with IFRS 15.',
    disclosure: 'Disaggregated revenue, contract balances and remaining performance obligations.',
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 606-10-45-2',
    topic: 'REVENUE',
    title: 'Advance from customer is a contract liability',
    requirement: 'Consideration received before performance is a contract liability.',
    treatment: 'Debit Cash, credit Contract Liability. Release to revenue as the obligation is satisfied.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'BANK', note: 'Cash received in advance' },
      { side: 'CREDIT', subtype: 'OTHER_CURRENT_LIABILITY', note: 'Contract liability / deferred revenue' },
    ],
    keywords: ['advance', 'deposit', 'prepayment', 'upfront', 'retainer', 'deferred revenue', 'unearned'],
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 842-20-25-2',
    topic: 'LEASES',
    title: 'Lessee classifies each lease as finance or operating',
    requirement:
      'A lease is a finance lease if it meets any of the five criteria (transfer of ownership, purchase option reasonably certain, major part of economic life, present value substantially all of fair value, specialised asset). Otherwise it is an operating lease.',
    treatment:
      'Both types put a right-of-use asset and lease liability on the balance sheet. A finance lease produces amortisation plus interest; an operating lease produces a single straight-line lease cost.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'FIXED_ASSET', note: 'Right-of-use asset' },
      { side: 'CREDIT', subtype: 'LONG_TERM_LIABILITY', note: 'Lease liability' },
    ],
    keywords: ['lease', 'rent agreement', 'right of use', 'rou', 'lessee', 'finance lease', 'operating lease'],
    divergenceNote: 'IFRS 16 has no operating/finance split for lessees — every lease produces amortisation plus interest. Expect a P&L geography difference between the two frameworks.',
    disclosure: 'Lease cost by type, weighted-average discount rate and remaining term, maturity analysis.',
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 330-10-30-9',
    topic: 'INVENTORY',
    title: 'LIFO permitted as a cost flow assumption',
    requirement: 'Cost may be determined under FIFO, LIFO, weighted average or specific identification.',
    treatment: 'Apply the chosen method consistently. A LIFO reserve is disclosed where LIFO is used.',
    keywords: ['lifo', 'fifo', 'weighted average', 'cost formula', 'inventory valuation', 'lifo reserve'],
    policyKey: 'inventory_cost_formula',
    divergenceNote: 'IAS 2 PROHIBITS LIFO. A US entity on LIFO must be converted for IFRS group reporting.',
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 330-10-35-1B',
    topic: 'INVENTORY',
    title: 'Inventory at the lower of cost and net realisable value',
    requirement: 'Inventory measured other than by LIFO or the retail method is stated at the lower of cost and net realisable value.',
    treatment: 'Debit Cost of Sales, credit Inventory. The written-down amount becomes the new cost basis.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'COST_OF_GOODS_SOLD', note: 'Write-down to net realisable value' },
      { side: 'CREDIT', subtype: 'OTHER_CURRENT_ASSET', note: 'Inventory' },
    ],
    keywords: ['inventory', 'stock', 'write down', 'obsolete', 'nrv'],
    divergenceNote: 'Unlike IAS 2, a write-down under US GAAP is NOT reversed if value recovers.',
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 360-10-30-1',
    topic: 'PPE',
    title: 'Property, plant and equipment at historical cost',
    requirement: 'PPE is recorded at cost, including costs necessary to bring the asset to its intended use.',
    treatment: 'Capitalise purchase price, freight, installation and testing. Revaluation to fair value is not permitted.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'FIXED_ASSET', note: 'Cost including directly attributable costs' },
      { side: 'CREDIT', subtype: 'ACCOUNTS_PAYABLE', note: 'Supplier' },
    ],
    keywords: ['equipment', 'machine', 'laptop', 'computer', 'vehicle', 'furniture', 'installation', 'capital'],
    policyKey: 'ppe_measurement',
    divergenceNote: 'IAS 16 permits a revaluation model. US GAAP does not.',
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 360-10-35-17',
    topic: 'IMPAIRMENT',
    title: 'Two-step impairment test for long-lived assets',
    requirement:
      'An impairment loss is recognised only if the carrying amount is not recoverable from undiscounted future cash flows; the loss is then measured as the excess of carrying amount over fair value.',
    treatment: 'Debit Impairment Loss, credit the asset. Once written down, the reduced amount is the new cost basis.',
    keywords: ['impairment', 'write off asset', 'recoverable', 'undiscounted cash flows'],
    divergenceNote:
      'IAS 36 uses a single discounted test, so IFRS recognises impairments earlier and more often. ASC 360-10-35-20 also PROHIBITS the reversal that IAS 36.114 requires.',
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 730-10-25-1',
    topic: 'INTANGIBLES',
    title: 'Research and development expensed as incurred',
    requirement: 'All research and development costs are charged to expense when incurred.',
    treatment: 'Debit R&D Expense, credit Bank or Payroll. Do not capitalise.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'EXPENSE', note: 'Research and development expenditure' },
      { side: 'CREDIT', subtype: 'BANK', note: 'Payment' },
    ],
    keywords: ['research', 'development', 'r&d', 'product build', 'engineering cost'],
    policyKey: 'development_costs',
    divergenceNote:
      'Headline divergence: IAS 38.57 REQUIRES capitalisation of development costs once six criteria are met. A group with both frameworks will show different intangible balances and different profit.',
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 350-40-25-1',
    topic: 'INTANGIBLES',
    title: 'Internal-use software — capitalise application development stage',
    requirement:
      'Costs in the preliminary project stage and post-implementation stage are expensed; costs in the application development stage are capitalised.',
    treatment: 'Debit Capitalised Software, credit Payroll or Accounts Payable, but only for the application development stage.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'OTHER_ASSET', note: 'Capitalised internal-use software' },
      { side: 'CREDIT', subtype: 'BANK', note: 'Development costs in the qualifying stage' },
    ],
    keywords: ['internal use software', 'software development', 'erp implementation', 'capitalise software'],
    divergenceNote: 'The nearest US GAAP equivalent to IAS 38.57, but narrower — it applies to software only, not development generally.',
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 450-20-25-2',
    topic: 'PROVISIONS',
    title: 'Loss contingency accrued when probable and reasonably estimable',
    requirement: 'An estimated loss is accrued only if it is probable that a liability had been incurred and the amount can be reasonably estimated.',
    treatment: 'Debit the related Expense, credit Accrued Liability. Where a range is equally likely, accrue the LOW end of the range.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'EXPENSE', note: 'Loss contingency' },
      { side: 'CREDIT', subtype: 'OTHER_CURRENT_LIABILITY', note: 'Accrued liability' },
    ],
    keywords: ['provision', 'contingency', 'legal claim', 'warranty', 'litigation', 'accrual for dispute'],
    divergenceNote:
      '"Probable" is a higher bar under ASC 450 than IAS 37\'s "more likely than not", and IAS 37 uses the midpoint of an equally likely range where ASC 450 uses the low end. Expect the IFRS provision to be larger.',
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 710-10-25-1',
    topic: 'EMPLOYEE_BENEFITS',
    title: 'Compensated absences accrued',
    requirement:
      'An employer accrues a liability for employees’ compensation for future absences where the obligation relates to services already rendered, vests or accumulates, payment is probable, and the amount is estimable.',
    treatment: 'Debit Salaries & Wages, credit Accrued Compensation.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'EXPENSE', note: 'Gross payroll cost' },
      { side: 'CREDIT', subtype: 'OTHER_CURRENT_LIABILITY', note: 'Withholdings and accrued leave' },
      { side: 'CREDIT', subtype: 'BANK', note: 'Net pay' },
    ],
    keywords: ['payroll', 'salary', 'wages', 'vacation accrual', 'pto', 'bonus'],
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 740-10-25-6',
    topic: 'INCOME_TAX',
    title: 'Deferred tax and uncertain tax positions',
    requirement:
      'Deferred taxes are recognised for temporary differences using enacted rates. A tax position is recognised only if it is more likely than not to be sustained on examination.',
    treatment: 'Debit or credit Deferred Tax Expense against a Deferred Tax Asset or Liability; record a valuation allowance where realisation is not more likely than not.',
    keywords: ['deferred tax', 'temporary difference', 'valuation allowance', 'uncertain tax position', 'fin 48'],
    divergenceNote:
      'ASC 740 requires fully ENACTED rates and uses a valuation allowance against gross DTAs. IAS 12 uses substantively enacted rates and recognises the DTA only to the extent recovery is probable — no separate allowance.',
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 830-20-35-1',
    topic: 'FOREIGN_CURRENCY',
    title: 'Transaction gains and losses in income',
    requirement: 'A change in exchange rates between the functional currency and the currency of a transaction produces a gain or loss included in income.',
    treatment: 'Debit or credit Foreign Exchange Gain/Loss against the related monetary balance.',
    keywords: ['fx gain', 'fx loss', 'exchange difference', 'foreign currency', 'retranslation'],
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 830-30-45-12',
    topic: 'FOREIGN_CURRENCY',
    title: 'Translation adjustment reported in other comprehensive income',
    requirement:
      'Assets and liabilities are translated at the current rate, revenues and expenses at the rate on the transaction dates, and the adjustment is reported in other comprehensive income.',
    treatment: 'Accumulate in the Cumulative Translation Adjustment within equity; reclassify to income on sale or complete liquidation of the investment.',
    keywords: ['translation', 'cta', 'consolidation currency', 'foreign subsidiary'],
    divergenceNote: 'Mechanically the same as IAS 21.39.',
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 835-20-25-1',
    topic: 'BORROWING_COSTS',
    title: 'Interest capitalised on qualifying assets',
    requirement: 'Interest cost is capitalised as part of the historical cost of assets that require a period of time to get ready for their intended use.',
    treatment: 'Debit the asset under construction rather than Interest Expense during the construction period.',
    keywords: ['interest', 'capitalise interest', 'construction', 'qualifying asset'],
    divergenceNote: 'IAS 23 computes the capitalisation rate and eligible borrowings slightly differently; amounts will not always agree.',
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 326-20-30-1',
    topic: 'FINANCIAL_INSTRUMENTS',
    title: 'Current expected credit losses (CECL)',
    requirement: 'An allowance for credit losses is measured at the amount expected over the contractual life of the asset, from initial recognition.',
    treatment: 'Debit Credit Loss Expense, credit Allowance for Credit Losses.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'EXPENSE', note: 'Credit loss expense' },
      { side: 'CREDIT', subtype: 'ACCOUNTS_RECEIVABLE', note: 'Allowance for credit losses' },
    ],
    keywords: ['bad debt', 'doubtful', 'cecl', 'allowance', 'credit loss', 'write off customer'],
    divergenceNote: 'IFRS 9 uses a three-stage model with 12-month losses at stage 1; CECL is lifetime from day one, so US allowances are usually larger at inception.',
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 810-10-45-1',
    topic: 'CONSOLIDATION',
    title: 'Consolidation and elimination of intra-entity items',
    requirement:
      'Consolidated statements present the parent and subsidiaries as a single economic entity; all intra-entity balances, transactions and profits are eliminated in full.',
    treatment: 'Eliminate intercompany receivables against payables and intra-entity sales against purchases; remove unrealised profit in inventory.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'ACCOUNTS_PAYABLE', note: 'Intra-entity payable' },
      { side: 'CREDIT', subtype: 'ACCOUNTS_RECEIVABLE', note: 'Matching receivable' },
    ],
    keywords: ['consolidation', 'intercompany', 'elimination', 'group', 'subsidiary', 'intra-entity'],
    divergenceNote: 'IFRS 10 uses a single control model; US GAAP applies the variable interest entity model first, then the voting model.',
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 810-10-45-16',
    topic: 'CONSOLIDATION',
    title: 'Non-controlling interest within equity',
    requirement: 'The non-controlling interest is reported in the consolidated statement of financial position within equity, separately from the parent’s equity.',
    treatment: 'Allocate net income and comprehensive income between the controlling and non-controlling interests.',
    keywords: ['nci', 'minority interest', 'non-controlling'],
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 350-20-35-1',
    topic: 'CONSOLIDATION',
    title: 'Goodwill not amortised (with a private-company alternative)',
    requirement: 'Goodwill is not amortised but is tested for impairment at least annually at the reporting-unit level.',
    treatment: 'Private companies may elect to amortise goodwill on a straight-line basis over ten years or less.',
    keywords: ['goodwill', 'acquisition', 'business combination', 'impairment test'],
    policyKey: 'goodwill_amortisation',
    divergenceNote: 'IFRS 3 does not permit goodwill amortisation under any circumstances.',
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 850-10-50-1',
    topic: 'RELATED_PARTIES',
    title: 'Related party disclosures',
    requirement: 'Financial statements disclose the nature of the relationship, a description of the transactions, dollar amounts, and amounts due to or from related parties.',
    treatment: 'No special posting; tag the counterparty as related.',
    keywords: ['related party', 'director loan', 'shareholder', 'affiliate'],
  },
  {
    framework: 'US_GAAP',
    reference: 'ASC 350-60 (ASU 2023-08)',
    topic: 'CRYPTO_ASSETS',
    title: 'Crypto assets measured at fair value through net income',
    requirement:
      'In-scope crypto assets — fungible intangible assets on a distributed ledger secured by cryptography, that are not issued by the reporting entity and confer no enforceable rights to other assets — are measured at fair value at each reporting date.',
    treatment:
      'Remeasure to fair value each period. Debit or credit the Crypto Asset and take the change to net income. Present separately from other intangibles.',
    entryTemplate: [
      { side: 'DEBIT', subtype: 'OTHER_ASSET', note: 'Crypto asset remeasured to fair value' },
      { side: 'CREDIT', subtype: 'OTHER_INCOME', note: 'Fair value gain (or debit an expense for a loss)' },
    ],
    keywords: ['crypto', 'bitcoin', 'ethereum', 'token', 'wallet', 'digital asset', 'stablecoin', 'usdt'],
    policyKey: 'crypto_classification',
    divergenceNote:
      'Major divergence. IFRS has no fair-value-through-profit-or-loss model for crypto — IAS 38 requires the cost or revaluation model, and gains are not recognised in profit or loss under cost. The same token is carried at two different amounts in a dual-framework group.',
    disclosure: 'Name, cost basis, fair value and units of each significant holding, plus a roll-forward of the period.',
  },
];

export const STANDARD_CATALOG: StandardRule[] = [...IFRS, ...US_GAAP];

/** Every topic where the two frameworks meaningfully differ. */
export const DIVERGENCES = STANDARD_CATALOG.filter((s) => s.divergenceNote).map((s) => ({
  framework: s.framework,
  reference: s.reference,
  topic: s.topic,
  title: s.title,
  note: s.divergenceNote!,
}));

/** Default accounting-policy choices offered when a company is created. */
export const DEFAULT_POLICIES: Record<Framework, { key: string; value: string; basis: string; note: string }[]> = {
  IFRS: [
    { key: 'inventory_cost_formula', value: 'FIFO', basis: 'IAS 2.25', note: 'LIFO is prohibited under IFRS.' },
    { key: 'ppe_measurement', value: 'COST_MODEL', basis: 'IAS 16.30', note: 'Revaluation model is available if fair value can be measured reliably.' },
    { key: 'development_costs', value: 'CAPITALISE_WHEN_CRITERIA_MET', basis: 'IAS 38.57', note: 'All six criteria must be demonstrated and documented.' },
    { key: 'crypto_classification', value: 'INTANGIBLE_COST_MODEL', basis: 'IAS 38.8', note: 'Inventory treatment applies only to broker-traders.' },
    { key: 'short_term_lease_exemption', value: 'APPLIED', basis: 'IFRS 16.6', note: 'Leases of 12 months or less are expensed straight-line.' },
    { key: 'grant_presentation', value: 'DEFERRED_INCOME', basis: 'IAS 20.24', note: 'Alternative is to net the grant against the asset.' },
  ],
  US_GAAP: [
    { key: 'inventory_cost_formula', value: 'FIFO', basis: 'ASC 330-10-30-9', note: 'LIFO is permitted; election has tax consequences.' },
    { key: 'ppe_measurement', value: 'COST_MODEL', basis: 'ASC 360-10-30-1', note: 'Revaluation is not permitted.' },
    { key: 'development_costs', value: 'EXPENSE_AS_INCURRED', basis: 'ASC 730-10-25-1', note: 'Internal-use software under ASC 350-40 is the exception.' },
    { key: 'crypto_classification', value: 'FAIR_VALUE_THROUGH_INCOME', basis: 'ASC 350-60', note: 'Applies to in-scope fungible crypto assets.' },
    { key: 'lease_classification', value: 'ASSESS_PER_LEASE', basis: 'ASC 842-20-25-2', note: 'Finance versus operating is tested against five criteria.' },
    { key: 'goodwill_amortisation', value: 'NOT_AMORTISED', basis: 'ASC 350-20-35-1', note: 'Private companies may elect straight-line amortisation.' },
  ],
};
