# Data Pipeline Pattern Selection Decision Matrix

**Task ID:** TASK-001C
**Deliverable:** Pattern selection framework for Microsoft Fabric Data Factory pipelines
**Created:** 2025-11-13

## Purpose

This decision matrix helps data engineers and architects select the appropriate data pipeline patterns based on project requirements, constraints, and objectives. Use this as a practical guide during pipeline design discussions.

---

## Quick Decision Tree

```
START: New Pipeline Design
│
├─ What is the data latency requirement?
│  ├─ < 1 minute → STREAMING
│  ├─ 1-15 minutes → MICRO-BATCH
│  └─ > 15 minutes → BATCH
│
├─ What is the target system?
│  ├─ Cloud Data Platform (Fabric/Synapse) → ELT
│  ├─ Limited Storage/Compute → ETL
│  └─ Hybrid → Light ETL + ELT
│
├─ How to handle changes?
│  ├─ Small dataset → FULL LOAD
│  ├─ Append-only → HIGH WATER MARK
│  ├─ Updates/Deletes → CDC
│  └─ No change tracking → DELTA/DIFF
│
└─ What is the data variety?
   ├─ Only structured → DATA WAREHOUSE
   ├─ Mixed types → LAKEHOUSE
   └─ Mostly unstructured → DATA LAKE
```

---

## 1. ETL vs ELT Selection Matrix

### Decision Criteria

| Criterion | Choose ETL | Choose ELT | Choose Hybrid |
|-----------|-----------|-----------|---------------|
| **Target Platform** | Legacy on-prem warehouse | Cloud data platform (Fabric, Synapse, Snowflake) | Mixed environment |
| **Target Storage Cost** | Expensive ($1000+/TB) | Moderate (<$100/TB) | Variable |
| **Target Compute Power** | Limited (single server) | Scalable (MPP, Spark) | Scalable with constraints |
| **Data Sensitivity** | PII/PHI requiring masking | Public or encrypted at rest | Mixed sensitivity |
| **Transformation Complexity** | Extremely complex (AI/ML models) | SQL-capable logic | Mix of simple and complex |
| **Data Volume** | < 100GB | > 100GB | Variable |
| **Schema Stability** | Stable (quarterly changes) | Volatile (weekly changes) | Mixed |
| **Reprocessing Need** | Rare | Frequent | Occasional |
| **Team Expertise** | ETL tool specialists (SSIS, Informatica) | SQL developers, data engineers | Mixed skills |
| **Time to Insight** | Not critical | Critical (fast raw data access) | Balanced |

### Scoring System

Rate each criterion on a scale of 1-5:
- **1 = Strongly favors ETL**
- **3 = Neutral**
- **5 = Strongly favors ELT**

**Decision:**
- Average Score < 2.5: **Use ETL**
- Average Score 2.5-3.5: **Use Hybrid (Light ETL)**
- Average Score > 3.5: **Use ELT**

### Microsoft Fabric Recommendation

**Default to ELT** unless:
- Extreme data sensitivity requiring transformation before landing
- Target is NOT a Fabric Lakehouse or SQL Database
- Regulatory compliance mandates pre-load transformation

**Fabric-Optimized ELT Pattern:**
```
Source → Copy Activity (minimal transform) → Lakehouse Bronze (raw)
         ↓
    Fabric Data Flow / Notebook (transform)
         ↓
    Lakehouse Silver (cleansed) / Gold (aggregated)
         ↓
    SQL Analytics Endpoint / Power BI
```

---

## 2. Change Data Capture (CDC) Pattern Selection

### Decision Matrix

| Factor | Full Load | High Water Mark | Database CDC | Delta/Diff | Streaming CDC |
|--------|-----------|-----------------|--------------|------------|---------------|
| **Data Volume** | < 10GB | 10GB-1TB | Any | 10GB-500GB | Any |
| **Change Frequency** | < 10% changes | > 10% inserts | Any | < 30% changes | Continuous |
| **Delete Detection** | Not needed | Not needed | Required | Required | Required |
| **Source Support** | Any | Timestamp/ID column | CDC enabled | Snapshot export | Event stream |
| **Latency Tolerance** | Hours-Days | Minutes-Hours | Minutes | Hours | Seconds |
| **Implementation Complexity** | Low | Low | Medium | High | Very High |
| **Operational Overhead** | Low | Low | Medium | High | High |
| **Storage Cost** | Low | Low | Low | High (2x data) | Medium |
| **Network Bandwidth** | High | Low-Medium | Low | High (2x data) | Low-Medium |
| **Audit Requirements** | None | Insert/Update | Complete | Complete | Complete |

### Selection Workflow

```
1. Can the source system provide a timestamp or incrementing ID?
   NO → Go to step 3
   YES → Use HIGH WATER MARK
         └─ Need delete detection?
            YES → Go to step 2
            NO → DECISION: High Water Mark ✓

2. Does the source database support native CDC?
   YES → Use DATABASE CDC ✓
   NO → Go to step 3

3. Is the dataset small (< 10GB)?
   YES → Use FULL LOAD ✓
   NO → Go to step 4

4. Can you store and compare snapshots?
   YES → Use DELTA/DIFF pattern
   NO → Go to step 5

5. Is real-time data required?
   YES → Use STREAMING CDC (Event Hub + Change Feed)
   NO → Reconsider requirements or use periodic FULL LOAD
```

### Weather Pipeline Recommendation

**Current:** Full Load (Truncate + Load)

**Assessment:**
- Weather data volume: Small (likely < 1GB)
- Update frequency: Likely periodic (hourly)
- Delete detection: Not required (append-only weather readings)

**Recommendation:**
- **Keep Full Load** if file size < 1GB
- **Switch to High Water Mark** if growing > 1GB:
  ```sql
  WHERE Timestamp > '@{activity('LookupLastRunTime').output.firstRow.MaxTimestamp}'
  ```

---

## 3. Batch vs Stream Processing Selection

### Decision Matrix

| Factor | Batch | Micro-Batch | Streaming | Hybrid (Lambda) |
|--------|-------|-------------|-----------|-----------------|
| **Latency SLA** | > 15 min | 1-15 min | < 1 min | Both |
| **Data Arrival Pattern** | Periodic files | Continuous micro | Event-driven | Both |
| **Processing Complexity** | High (joins, aggregates) | Medium | Low-Medium | High |
| **State Management** | Simple (batch state) | Medium | Complex (windowing) | Complex |
| **Cost (per GB)** | Low | Medium | High | Very High |
| **Infrastructure** | Simple | Medium | Complex | Very Complex |
| **Debugging** | Easy | Medium | Difficult | Very Difficult |
| **Reprocessing** | Easy (rerun batch) | Medium | Difficult (replay) | Medium |
| **Use Cases** | Daily reports, ETL | Near-real-time dashboards | Alerting, fraud detection | Mission-critical analytics |

### Selection Guide

**Choose BATCH if:**
- ✓ Data arrives in files/dumps (hourly, daily)
- ✓ Business processes operate on batch schedules
- ✓ Complex multi-table joins and aggregations
- ✓ Cost optimization is priority
- ✓ Latency > 15 minutes acceptable

**Choose STREAMING if:**
- ✓ Events arrive continuously
- ✓ Real-time alerting required
- ✓ Per-event processing (fraud detection)
- ✓ Latency < 1 minute required
- ✓ Event-driven architecture

**Choose MICRO-BATCH if:**
- ✓ Near-real-time needs (1-15 min latency)
- ✓ Balance cost and latency
- ✓ Tumbling window processing
- ✓ Medium complexity transformations

**Choose HYBRID (Lambda) if:**
- ✓ Need both real-time AND accurate historical
- ✓ Mission-critical use case
- ✓ Budget supports dual pipelines
- ✓ Example: Streaming for alerts, batch for ML training

### Fabric Implementation Patterns

| Pattern | Fabric Service | Trigger Type | Example |
|---------|----------------|--------------|---------|
| **Batch** | Data Pipeline + Copy Activity | Schedule | Daily ETL |
| **Batch** | Data Pipeline + Notebook | Tumbling Window | Hourly aggregation |
| **Micro-Batch** | Event Stream + Notebook | Event | 5-min micro-batches |
| **Streaming** | Real-Time Analytics | Event Hub | IoT sensor data |
| **Streaming** | Event Stream + KQL | Continuous | Clickstream analytics |

### Weather Pipeline Recommendation

**Current:** Batch (file-based)

**Assessment:**
- Weather readings: Periodic (likely hourly)
- Use case: Historical analysis and reporting
- Latency tolerance: Hours acceptable

**Recommendation:**
- **Keep Batch** for file-based weather data
- **Consider Streaming** if:
  - Weather station can push events in real-time
  - Severe weather alerts needed
  - Real-time dashboard required

**Hybrid Pattern (if needed):**
```
Weather Station → Event Hub (real-time alerts) → Real-Time Analytics → Power BI
                      ↓
                Lakehouse Bronze (historical) → Batch Aggregation → SQL Database
```

---

## 4. Data Lake vs Data Warehouse vs Lakehouse

### Decision Matrix

| Factor | Data Warehouse | Data Lake | Lakehouse |
|--------|----------------|-----------|-----------|
| **Data Types** | Structured only | All types | All types |
| **Schema Management** | Strict (schema-on-write) | Flexible (schema-on-read) | Flexible with enforcement |
| **Query Performance** | Optimized (indexes, aggregates) | Variable (raw files) | Good (Delta Lake optimization) |
| **Storage Cost** | High | Low | Medium |
| **Compute Cost** | Medium | Variable | Medium |
| **Governance Maturity** | Very High | Low-Medium | Medium-High |
| **Data Quality** | High (enforced) | Variable | Medium-High (configurable) |
| **Use Cases** | BI, reporting | Data science, ML, exploration | Both |
| **User Personas** | Business analysts | Data scientists, engineers | Both |
| **Time to Value** | Medium (modeling required) | Fast (dump and query) | Medium |
| **Schema Evolution** | Difficult | Easy | Easy |
| **ACID Transactions** | Yes | No | Yes (Delta Lake) |
| **Historical Analysis** | Limited (aggregates) | Complete (raw data) | Complete |

### Selection Framework

**Step 1: Identify Primary Use Case**

| Use Case | Recommended Pattern |
|----------|---------------------|
| Structured BI reporting with known dimensions | **Data Warehouse** |
| Exploratory data analysis (unknown queries) | **Data Lake** |
| Machine learning feature engineering | **Data Lake** or **Lakehouse** |
| Regulated financial reporting | **Data Warehouse** |
| Unstructured data (logs, images, video) | **Data Lake** |
| Mixed analytics (BI + ML) | **Lakehouse** |
| IoT sensor data (JSON, time-series) | **Lakehouse** |
| Legacy BI tool integration | **Data Warehouse** |

**Step 2: Assess Data Characteristics**

| Characteristic | Warehouse Score | Lake Score | Lakehouse Score |
|----------------|----------------|------------|-----------------|
| 100% structured data | +3 | 0 | +1 |
| 50-99% structured | +1 | +1 | +3 |
| < 50% structured | 0 | +3 | +2 |
| Schema changes monthly | -2 | +2 | +2 |
| Schema changes quarterly | +1 | +1 | +2 |
| Schema stable (annual) | +3 | 0 | +1 |
| Data volume < 1TB | +2 | +1 | +2 |
| Data volume 1-10TB | +1 | +2 | +3 |
| Data volume > 10TB | 0 | +3 | +3 |
| Query pattern: known reports | +3 | 0 | +2 |
| Query pattern: exploratory | 0 | +3 | +2 |

**Highest Score → Recommended Pattern**

**Step 3: Consider Team and Tech Stack**

- **Existing SQL expertise** → Warehouse or Lakehouse
- **Python/Spark expertise** → Lake or Lakehouse
- **Business analyst users** → Warehouse or Lakehouse (SQL endpoint)
- **Data scientist users** → Lake or Lakehouse
- **Microsoft Fabric environment** → **Lakehouse (recommended)**

### Microsoft Fabric Specific Recommendation

**Default: Lakehouse with Medallion Architecture**

```
Bronze Layer (Data Lake pattern)
  - Raw ingestion, all formats
  - Schema-on-read
  - Data lineage tracking

Silver Layer (Data Lake pattern)
  - Cleansed, validated
  - Deduplicated
  - Conformed formats

Gold Layer (Data Warehouse pattern)
  - Business-level aggregates
  - Star/snowflake schemas
  - Power BI optimized
```

**Use dedicated SQL Database (Warehouse) when:**
- Legacy tools require SQL Server compatibility
- Extreme query performance needed (pre-aggregation)
- Regulatory requirement for separate warehouse

**Use pure Data Lake (OneLake folders) when:**
- Unstructured data only (images, videos, logs)
- Data science playground
- Temporary exploratory workloads

### Weather Pipeline Recommendation

**Current:** Data Warehouse pattern (SQL Database staging table)

**Assessment:**
- Data type: Structured (CSV with fixed schema)
- Use case: Likely BI reporting
- Volume: Small (< 1GB estimated)
- Schema stability: High (weather metrics don't change often)

**Recommendation:**
- **Current approach is valid** for small-scale structured reporting
- **Consider Lakehouse upgrade** for future scalability:

```
Ideal Future State:
1. CSV → Lakehouse Bronze (raw CSV preserved)
2. Notebook → Silver (cleansed, typed columns, deduplication)
3. SQL View → Gold (daily/hourly aggregates)
4. Power BI → Direct Lake on Gold layer
```

**Benefits of Lakehouse approach:**
- Raw data preserved for reprocessing
- Scalable to larger volumes
- Support for additional weather data formats (JSON, Parquet)
- Better performance with Delta Lake optimization

---

## 5. Combined Pattern Decision Matrix

### Recommended Pattern Combinations

| Scenario | ETL/ELT | CDC | Batch/Stream | Storage |
|----------|---------|-----|--------------|---------|
| **Small periodic structured data** | Light ETL | Full Load | Batch | Warehouse |
| **Large periodic structured data** | ELT | High Water Mark | Batch | Lakehouse |
| **Real-time structured events** | ELT | Streaming CDC | Stream | Lakehouse |
| **Mixed data types, periodic** | ELT | High Water Mark | Batch | Lakehouse |
| **Mixed data types, real-time** | ELT | Streaming CDC | Stream | Lakehouse |
| **Legacy system migration** | ETL | Database CDC | Batch | Warehouse |
| **IoT sensor data** | ELT | Streaming | Micro-batch | Lakehouse |
| **Financial transactions** | Light ETL | Database CDC | Stream + Batch | Lakehouse + Warehouse |
| **Log analytics** | ELT | N/A (append-only) | Batch | Data Lake |
| **E-commerce clickstream** | ELT | Streaming | Stream | Lakehouse |

### Weather Pipeline Current State Analysis

| Pattern Category | Current Implementation | Score (1-5) | Recommendation |
|------------------|------------------------|-------------|----------------|
| **ETL/ELT** | Light ETL (column mapping) | 4/5 | Appropriate ✓ |
| **CDC** | Full Load (truncate + load) | 5/5 | Appropriate for small data ✓ |
| **Batch/Stream** | Batch (file-based) | 5/5 | Appropriate ✓ |
| **Storage** | Warehouse (SQL staging) | 3/5 | Consider Lakehouse for future |

**Overall Assessment:** Current patterns are appropriate for a small-scale, periodic weather data pipeline.

---

## 6. Pattern Evolution Roadmap

### Maturity Model

**Level 1: Basic (Current Weather Pipeline)**
- ETL with simple transformations
- Full load pattern
- Batch processing
- Single destination warehouse

**Level 2: Intermediate**
- ELT with target-based transformations
- Incremental loading (high water mark)
- Scheduled batch with tumbling windows
- Lakehouse Bronze + Silver layers

**Level 3: Advanced**
- ELT with medallion architecture
- Database CDC or delta/diff
- Micro-batch processing
- Lakehouse Bronze + Silver + Gold with SQL endpoint

**Level 4: Mature**
- ELT with real-time and batch paths
- Streaming CDC
- Hybrid Lambda architecture
- Lakehouse with multiple consumption layers

**Level 5: Optimized**
- Fully automated ELT with CI/CD
- Event-driven streaming with replay
- Kappa architecture (streaming-only)
- Lakehouse with data mesh principles

### Evolution Path for Weather Pipeline

```
Current (Level 1)
    ↓
Step 1: Add Lakehouse (Level 2)
  - Keep current pipeline for continuity
  - Add parallel path: CSV → Lakehouse Bronze
  - Notebook transformation → Silver
    ↓
Step 2: Incremental Loading (Level 2)
  - Add high water mark parameter
  - Modify Copy Activity to filter by timestamp
  - Add pipeline variables for state management
    ↓
Step 3: Medallion Architecture (Level 3)
  - Create Gold layer with aggregates
  - Add SQL endpoint for BI tools
  - Sunset direct CSV → SQL pipeline
    ↓
Step 4: Streaming (if needed - Level 4)
  - Replace file drop with Event Hub
  - Add Real-Time Analytics for alerts
  - Keep batch for historical processing
```

---

## 7. Quick Reference: Pattern Selection Checklist

### Before Starting Any Pipeline Design

- [ ] **Data Volume:** ___________ GB/TB
- [ ] **Update Frequency:** ___________
- [ ] **Latency Requirement:** ___________ minutes/seconds
- [ ] **Data Types:** Structured / Semi / Unstructured
- [ ] **Source System:** ___________
- [ ] **Target System:** ___________
- [ ] **Change Tracking Available:** Yes / No
- [ ] **Delete Detection Required:** Yes / No
- [ ] **Primary Use Case:** BI / ML / Operational / Mixed
- [ ] **User Personas:** Business Analyst / Data Scientist / Engineer
- [ ] **Compliance Requirements:** ___________
- [ ] **Budget Constraints:** ___________
- [ ] **Team Expertise:** SQL / Python / ETL Tools / Streaming

### Pattern Selections

Based on checklist:
- [ ] **ETL** or **ELT** or **Hybrid:** ___________
- [ ] **CDC Pattern:** Full / Incremental / CDC / Delta / Streaming
- [ ] **Processing:** Batch / Micro-Batch / Stream / Lambda
- [ ] **Storage:** Warehouse / Lake / Lakehouse

### Validation Questions

- [ ] Does this pattern combination make sense together?
- [ ] Have we considered future scalability?
- [ ] Is the team capable of implementing and maintaining this?
- [ ] Does this align with Microsoft Fabric best practices?
- [ ] Have we considered cost implications?
- [ ] Is there a simpler pattern that would work?

---

## 8. Common Anti-Patterns to Avoid

| Anti-Pattern | Description | Correct Approach |
|--------------|-------------|------------------|
| **Over-engineering** | Using streaming for daily reports | Use batch for non-real-time needs |
| **Under-engineering** | Full load on 1TB tables | Implement incremental loading |
| **ETL on cloud** | Complex ETL before loading to Fabric | Use ELT to leverage cloud compute |
| **Data swamp** | Data Lake with no governance | Implement medallion architecture |
| **Premature optimization** | Complex CDC for small datasets | Start with full load, evolve as needed |
| **Lambda complexity** | Two pipelines when one would work | Use Kappa (streaming only) if possible |
| **Schema chaos** | No schema enforcement in lake | Use Lakehouse with Delta Lake constraints |
| **Monolithic pipelines** | Single pipeline doing everything | Decompose into modular components |

---

## 9. Success Metrics

### Pattern Selection Success Indicators

**Good Pattern Selection:**
- ✓ Meets latency SLAs consistently
- ✓ Within budget (compute + storage)
- ✓ Team can maintain without constant firefighting
- ✓ Scales linearly with data growth
- ✓ Supports current AND anticipated use cases

**Poor Pattern Selection:**
- ✗ Frequent pipeline failures
- ✗ Cost overruns (>20% over budget)
- ✗ Cannot meet latency requirements
- ✗ Requires constant re-architecture
- ✗ Limits business capabilities

### Monitoring Metrics by Pattern

| Pattern | Key Metrics |
|---------|-------------|
| **ETL** | Transformation time, staging storage cost |
| **ELT** | Query performance on raw data, target compute cost |
| **Full Load** | Total runtime, network bandwidth |
| **Incremental** | Change detection accuracy, missed records |
| **Batch** | Batch window duration, job success rate |
| **Stream** | End-to-end latency, event throughput |
| **Warehouse** | Query performance, storage cost |
| **Lake** | Storage cost, data discovery time |
| **Lakehouse** | Delta optimization frequency, query performance |

---

## Conclusion

Pattern selection is not a one-time decision but an iterative process. Start with the simplest pattern that meets requirements, instrument with monitoring, and evolve based on actual usage patterns and business needs.

**For Microsoft Fabric:**
- **Default to:** ELT + Lakehouse + Medallion + Incremental + Batch
- **Evolve to:** Streaming and advanced patterns as requirements emerge
- **Avoid:** Over-engineering on day one

**For Weather Pipeline:**
- Current pattern is appropriate for current scale
- Plan evolution to Lakehouse as data grows
- Consider streaming only if real-time alerts become a requirement

---

**Document Status:** Complete
**Related Documents:** `/documentation/task-001/data-patterns.md`
**Author:** Claude Code (Session 1C)
**Last Updated:** 2025-11-13
