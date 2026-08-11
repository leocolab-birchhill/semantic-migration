WITH scoped AS (
  SELECT *
  FROM databricks_prd.dbt_production.fct_tam_buildings
  WHERE (
      lower(property_manager_name) LIKE '%'
      OR lower(key_tenant_name) LIKE '%'
      OR lower(owner_name) LIKE '%'
      OR lower(cust_parent_customer) LIKE '%'
    )
    AND property_id <> '10630US'
    AND coalesce(sector, '') <> 'Residential'
    AND outside_geographic_tam = 'F'
    AND (building_rba IS NULL OR building_rba >= 20000)
), derived AS (
  SELECT
    scoped.*,
    CASE
      WHEN customer_match_status = 'No Market ID'
        THEN coalesce(parent_cust_sf_estimate, 0) >= 100000
      WHEN customer_match_status IN ('Matched: In TAM', 'Not a Customer')
        THEN coalesce(building_rba, 0) >= 20000
          AND CASE
            WHEN lower(coalesce(trim(account), '')) IN ('', 'n/a', '0')
             AND lower(coalesce(trim(property_manager_name), '')) IN ('', 'n/a', '0')
             AND lower(coalesce(trim(owner_name), '')) IN ('', 'n/a', '0')
             AND lower(coalesce(trim(key_tenant_name), '')) IN ('', 'n/a', '0')
              THEN coalesce(building_rba, 0) >= 100000
            ELSE coalesce(account_sf_total, 0) >= 100000
              OR coalesce(property_manager_sf_total, 0) >= 100000
              OR coalesce(owner_sf_total, 0) >= 100000
              OR coalesce(key_tenant_sf_total, 0) >= 100000
          END
      ELSE FALSE
    END AS in_extended_tam_scope_flag_default,
    CASE WHEN trim(consolidated_sector_2) = '' THEN NULL ELSE consolidated_sector_2 END AS consolidated_sector_2_semantic,
    coalesce(building_sf_occupied_by_account, customer_sf_estimate) AS building_sf_customer_adjusted,
    right(naics, 6) AS naics_code_semantic
  FROM scoped
)
SELECT
  derived.*,
  CASE
    WHEN consolidated_sector_2_semantic = 'Office' THEN 1
    WHEN consolidated_sector_2_semantic = 'Industrial' THEN 2
    WHEN consolidated_sector_2_semantic = 'Warehouse/Distribution' THEN 3
    WHEN consolidated_sector_2_semantic = 'Manufacturing' THEN 4
    WHEN consolidated_sector_2_semantic = 'Retail' THEN 5
    WHEN consolidated_sector_2_semantic = 'Specialty' THEN 6
    WHEN consolidated_sector_2_semantic = 'Healthcare' THEN 7
    ELSE 999
  END AS consolidated_sector_2_sort_semantic,
  CASE
    WHEN sector = 'Office - Multi-Tenant' THEN 1
    WHEN sector = 'Office - Single-Tenant' THEN 2
    WHEN sector = 'Flex' THEN 3
    WHEN sector = 'Hospitals' THEN 4
    WHEN sector = 'Long Term Care' THEN 5
    WHEN sector = 'Healthcare - General' THEN 6
    WHEN sector = 'Manufacturing' THEN 7
    WHEN sector = 'Warehouse/Distribution' THEN 8
    WHEN sector = 'Food Processing' THEN 9
    WHEN sector = 'Data Centers' THEN 10
    WHEN sector = 'Industrial - General' THEN 11
    WHEN sector = 'Retail - General' THEN 12
    WHEN sector = 'Freestanding and Department Stores' THEN 13
    WHEN sector = 'Shopping Malls' THEN 14
    WHEN sector = 'Airports' THEN 15
    WHEN sector = 'Airplane Hangars' THEN 16
    WHEN sector = 'Schools' THEN 17
    WHEN sector = 'Sports & Entertainment' THEN 18
    WHEN sector = 'Hotels & Hospitality' THEN 19
    WHEN sector = 'Other' THEN 20
    ELSE 999
  END AS sector_sort_semantic
FROM derived
