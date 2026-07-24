// Local ESLint plugin for OUTPILOT v2 conventions. No package.json needed —
// flat config imports this file directly. Fase 0 · T009.
//
// Rules:
//   outpilot/require-tenant-id-filter
//     Enforces spec constitution point 6: any Supabase query issued from
//     src/jobs/** must filter tenant_id explicitly. Applies to select /
//     update / delete style chains (`.from(t).X().eq('tenant_id', ...)`).
//     Insert / upsert calls are skipped by design — the payload check is
//     harder to model statically and is deferred; those callers must pass
//     tenant_id in the payload object, verified in review.

/**
 * Walk up the call chain that starts at a `.from(...)` CallExpression and
 * collect every method call node in the chain (top to bottom, in evaluation
 * order the outer/last call comes first).
 */
function collectChainCalls(fromCallNode) {
  // Ascend: while the current node is the object of a MemberExpression whose
  // parent CallExpression uses that MemberExpression as its callee, we are
  // still inside the chain.
  let cur = fromCallNode;
  while (
    cur.parent &&
    cur.parent.type === "MemberExpression" &&
    cur.parent.object === cur &&
    cur.parent.parent &&
    cur.parent.parent.type === "CallExpression" &&
    cur.parent.parent.callee === cur.parent
  ) {
    cur = cur.parent.parent;
  }
  // Descend: walk down through .callee.object to collect every CallExpression.
  const calls = [];
  let walker = cur;
  while (walker && walker.type === "CallExpression") {
    calls.push(walker);
    if (walker.callee.type !== "MemberExpression") break;
    walker = walker.callee.object;
  }
  return calls;
}

function isTenantIdEqCall(node) {
  if (node.callee.type !== "MemberExpression") return false;
  if (node.callee.property.type !== "Identifier") return false;
  if (node.callee.property.name !== "eq") return false;
  if (node.arguments.length < 2) return false;
  const first = node.arguments[0];
  return first.type === "Literal" && first.value === "tenant_id";
}

function isTenantIdMatchCall(node) {
  if (node.callee.type !== "MemberExpression") return false;
  if (node.callee.property.type !== "Identifier") return false;
  if (node.callee.property.name !== "match") return false;
  if (node.arguments.length < 1) return false;
  const arg = node.arguments[0];
  if (arg.type !== "ObjectExpression") return false;
  return arg.properties.some((p) => {
    if (p.type !== "Property") return false;
    if (p.key.type === "Identifier") return p.key.name === "tenant_id";
    if (p.key.type === "Literal") return p.key.value === "tenant_id";
    return false;
  });
}

function isInsertOrUpsertCall(node) {
  if (node.callee.type !== "MemberExpression") return false;
  if (node.callee.property.type !== "Identifier") return false;
  return (
    node.callee.property.name === "insert" ||
    node.callee.property.name === "upsert"
  );
}

const requireTenantIdFilter = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Supabase queries under src/jobs/** must filter by tenant_id (constitution §6).",
    },
    schema: [],
    messages: {
      missing:
        "Supabase query on '{{ table }}' from a job must include .eq('tenant_id', ...) or .match({ tenant_id: ... }). Insert/upsert callers must include tenant_id in the payload (not checked here).",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        if (callee.property.type !== "Identifier") return;
        if (callee.property.name !== "from") return;

        // Only interested in the leading .from() of a chain (avoid re-reporting
        // nested froms if any). If the parent is a MemberExpression with this
        // node as object and grandparent a CallExpression, we're at a leading
        // .from(); if not, we're a standalone .from() (still leading).
        // No special handling needed — we report once per chain because we
        // always compute the same chain from the leading .from().

        const tableArg = node.arguments[0];
        const tableName =
          tableArg &&
          tableArg.type === "Literal" &&
          typeof tableArg.value === "string"
            ? tableArg.value
            : "<unknown>";

        const chain = collectChainCalls(node);

        for (const call of chain) {
          if (isInsertOrUpsertCall(call)) return; // payload check deferred
          if (isTenantIdEqCall(call)) return;
          if (isTenantIdMatchCall(call)) return;
        }

        context.report({
          node,
          messageId: "missing",
          data: { table: tableName },
        });
      },
    };
  },
};

const plugin = {
  meta: {
    name: "outpilot-eslint-plugin",
    version: "0.0.1",
  },
  rules: {
    "require-tenant-id-filter": requireTenantIdFilter,
  },
};

export default plugin;
