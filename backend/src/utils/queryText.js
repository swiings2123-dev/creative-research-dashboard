/**
 * "<brand> <productType>" unless the product type already names the brand
 * (e.g. brand "Nike" + type "nike shoes" -> "nike shoes", not "Nike nike shoes").
 */
function brandedProduct(brand, productType) {
  if (!brand) return productType;
  return productType.toLowerCase().includes(brand.toLowerCase()) ? productType : `${brand} ${productType}`;
}

module.exports = { brandedProduct };
