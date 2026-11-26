export function purchaseMultiple(pricing, product) {
  if (pricing?.allowSalesMultiple === false) return Math.max(1, Number(product.units_per_box) || 1)
  const branch = Number(pricing?.stockBranch)
  const branchMultiple = branch === 1 ? product.sales_multiple_branch_1 : branch === 3 ? product.sales_multiple_branch_3 : null
  return Math.max(1, Number(branchMultiple) || Number(product.sales_multiple) || 1)
}
