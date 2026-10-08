import type { ModelUsage } from './events/span'
import type { ModelCost } from './resources/model'

/**
 * What a pile of tokens costs (epic #245, A2; issue #247).
 *
 * Cost is **never stored and never estimated**: every number here is computed when it is read,
 * from the token counters a `span.model_request_end` really reported and the list prices the
 * model catalog carries (`ModelEntry.cost`, from the vendored models.dev snapshot). Two
 * readers — the server's usage routes and the frontends' reply metadata — price the same
 * tokens with the same arithmetic, which is why the arithmetic lives in the protocol they all
 * depend on rather than in one of them.
 *
 * The rules, and there are only three:
 *
 * - **Rates are per million tokens, in USD.** models.dev publishes them that way; the division
 *   happens here so no caller has to remember it.
 * - **Cache tokens are priced separately where models.dev has those rates** — `cache_read` and
 *   `cache_write` are their own prices, not a fraction of the input rate, because a cached
 *   token really is a different price at every provider.
 * - **A token count we have no rate for is `null`, never `0`.** A model with no price at all
 *   contributes its tokens and reports no cost; one that publishes an input and output rate but
 *   no cache rates reports no cost for a request that used cache tokens, because charging
 *   nothing for tokens that were really spent would understate the bill. A count of zero costs
 *   zero whatever the rate is — nothing was spent — which is what keeps a request without cache
 *   tokens priceable on a model that has no cache rate.
 */

/**
 * The cost of the tokens in `usage`, in USD, at `cost`'s rates — or `null` when it cannot be
 * known: the model has no price, or it has none for a counter that is not zero.
 *
 * @param usage the token counters of one request, or the totals of many
 * @param cost the model's list price, or `null` when the catalog has none for it
 */
export function usageCost(usage: ModelUsage, cost: ModelCost | null): number | null {
  if (cost === null) {
    return null
  }
  const counters: readonly (readonly [number, number | null])[] = [
    [usage.input_tokens, cost.input],
    [usage.output_tokens, cost.output],
    [usage.cache_creation_input_tokens, cost.cache_write],
    [usage.cache_read_input_tokens, cost.cache_read],
  ]
  let total = 0
  for (const [tokens, rate] of counters) {
    if (tokens === 0) {
      continue
    }
    if (rate === null) {
      // Tokens that were really spent, at a rate nobody published: the honest answer is that
      // the cost is unknown. Coercing the rate to zero would be an estimate.
      return null
    }
    total += tokens * rate
  }
  return total / 1_000_000
}

/**
 * The sum of a set of costs, or `null` when **any** of them is unknown.
 *
 * A total is only as knowable as its least knowable part: a session that made one request
 * against a model nobody publishes a price for has no total cost, however cheap its other
 * requests were. An empty set is `null` too — nothing was spent, but nothing was priced
 * either, and a reader that must show a number can treat that case as it likes.
 */
export function totalCost(costs: Iterable<number | null>): number | null {
  let total = 0
  let priced = false
  for (const cost of costs) {
    if (cost === null) {
      return null
    }
    total += cost
    priced = true
  }
  return priced ? total : null
}
