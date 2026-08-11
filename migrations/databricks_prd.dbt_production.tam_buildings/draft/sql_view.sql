SELECT
  b.*,
  CASE
    WHEN lower(coalesce(trim(b.account), '')) IN ('', 'n/a', '0')
     AND lower(coalesce(trim(b.property_manager_name), '')) IN ('', 'n/a', '0')
     AND lower(coalesce(trim(b.owner_name), '')) IN ('', 'n/a', '0')
     AND lower(coalesce(trim(b.key_tenant_name), '')) IN ('', 'n/a', '0')
      THEN coalesce(b.building_rba, 0)
    ELSE greatest(
      coalesce(b.account_sf_total, 0),
      coalesce(b.property_manager_sf_total, 0),
      coalesce(b.owner_sf_total, 0),
      coalesce(b.key_tenant_sf_total, 0)
    )
  END AS _mv_sf_threshold_basis,
  b.customer_acv_year AS _mv_customer_acv_year_cad,
  b.customer_acv_year_usd AS _mv_customer_acv_year_usd,
  b.revenue_estimate_cad AS _mv_revenue_estimate_cad,
  b.revenue_estimate_usd AS _mv_revenue_estimate_usd,
  b.customer_gross_profit_cad AS _mv_customer_gross_profit_cad,
  b.customer_gross_profit_usd AS _mv_customer_gross_profit_usd,
  b.customer_revenue_cad AS _mv_customer_revenue_cad,
  b.customer_revenue_usd AS _mv_customer_revenue_usd,
  b.rate_cad AS _mv_rate_cad,
  b.rate_usd AS _mv_rate_usd
FROM databricks_prd.dbt_production.fct_tam_buildings b
WHERE
  (
    lower(b.property_manager_name) LIKE '%'
    OR lower(b.key_tenant_name) LIKE '%'
    OR lower(b.owner_name) LIKE '%'
    OR lower(b.cust_parent_customer) LIKE '%'
  )
  AND b.property_id <> '10630US'
  AND coalesce(b.sector, '') <> 'Residential'
  AND b.outside_geographic_tam = 'F'
  AND (b.building_rba IS NULL OR b.building_rba >= 20000)
