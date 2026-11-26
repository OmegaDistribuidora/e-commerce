import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { purchaseMultiple } from './purchase-multiple.js'

const coffee = {
  units_per_box: 20,
  sales_multiple: 5,
  sales_multiple_branch_1: 2,
  sales_multiple_branch_3: 10,
}

test('usa o múltiplo cadastrado na filial de estoque do cliente', () => {
  assert.equal(purchaseMultiple({ stockBranch: 1, allowSalesMultiple: true }, coffee), 2)
  assert.equal(purchaseMultiple({ stockBranch: 3, allowSalesMultiple: true }, coffee), 10)
})

test('preserva a regra de caixa fechada e o fallback para cadastro geral', () => {
  assert.equal(purchaseMultiple({ stockBranch: 1, allowSalesMultiple: false }, coffee), 20)
  assert.equal(purchaseMultiple({ stockBranch: 3, allowSalesMultiple: false }, coffee), 20)
  assert.equal(purchaseMultiple({ stockBranch: 1 }, { ...coffee, sales_multiple_branch_1: 0 }), 5)
  assert.equal(purchaseMultiple(null, coffee), 5)
})
