# Data Pipeline Specific Patterns

**Task ID:** TASK-001C
**Focus:** Data-specific architectural patterns for pipeline design
**Created:** 2025-11-13

## Executive Summary

This document explores four fundamental data pipeline pattern categories that are essential for designing scalable, maintainable Microsoft Fabric Data Factory (FDF) pipelines. Each pattern addresses specific architectural decisions that impact performance, scalability, and maintainability.

---

## 1. ETL vs ELT Patterns

### ETL (Extract, Transform, Load)

**Definition:** Data is extracted from source systems, transformed in an intermediate processing layer, and then loaded into the target system.

**Characteristics:**
- Transformation occurs **before** loading to target
- Requires separate transformation engine/staging area
- Data cleansing and business logic applied in transit
- Only transformed data reaches the target system
- Traditional approach, optimized for on-premises data warehouses

**When to Use ETL:**
- Limited storage capacity in target system
- Expensive target system (compute/storage costs)
- Need to mask/encrypt sensitive data before storage
- Complex transformations requiring specialized tools
- Target system has limited processing power
- Regulatory requirements mandate data cleansing before storage

**Advantages:**
- Reduces storage requirements in target
- Protects sensitive data through early transformation
- Optimized for row-based databases
- Lower network bandwidth for final load
- Better for complex business logic

**Disadvantages:**
- Longer time-to-insight (transformation delay)
- Requires additional transformation infrastructure
- Limited flexibility for reprocessing
- Transformation logic separate from data storage

**FDF Implementation:**
- Use Copy Activity with Data Flow transformations
- Staging area in Azure Blob Storage or Data Lake
- Data Flow for complex transformations
- Computed columns in Copy Activity for simple transforms

### ELT (Extract, Load, Transform)

**Definition:** Data is extracted from source, loaded into target system in raw/semi-raw form, and transformed within the target system.

**Characteristics:**
- Transformation occurs **after** loading to target
- Leverages target system's processing power
- Raw data preserved in target (data lake pattern)
- Modern approach, optimized for cloud data platforms
- Schema-on-read philosophy

**When to Use ELT:**
- Using cloud data platforms (Snowflake, Synapse, Fabric)
- Target has powerful processing capabilities
- Need to preserve raw data for auditing/reprocessing
- Scalability and parallel processing are priorities
- Frequent schema changes expected
- Multiple downstream consumers with different needs

**Advantages:**
- Faster initial data availability
- Leverages target system's parallel processing
- Raw data preserved for reprocessing
- More flexible for changing requirements
- Simplified pipeline architecture
- Better for columnar/MPP databases

**Disadvantages:**
- Requires robust target system
- Higher storage costs (raw + transformed)
- Potential data quality issues in raw layer
- Network bandwidth for full data load

**FDF Implementation:**
- Copy Activity for direct load to Fabric SQL Database
- SQL stored procedures for transformation
- Fabric Notebooks for complex transformations
- Lakehouse for raw data storage with SQL transformations

**Microsoft Fabric Recommendation:**
- **Primary Pattern:** ELT
- Fabric's medallion architecture (Bronze → Silver → Gold)
- Leverage Spark and SQL compute for transformations
- Use OneLake for unified storage

---

## 2. Change Data Capture (CDC) Patterns

### Full Load Pattern

**Description:** Complete dataset extracted and loaded on each run.

**Characteristics:**
- Simple implementation: "SELECT * FROM source"
- No tracking of changes required
- Target typically truncated before load
- Idempotent operation

**When to Use:**
- Small datasets (< 1GB)
- Source doesn't support change tracking
- Complete refresh acceptable
- Historical data not required

**FDF Example (from pipeline-content.json):**
```json
"preCopyScript": "Truncate Table stage.WxReading;"
```
This is a full load pattern - truncate and replace.

### Incremental Load with High Water Mark

**Description:** Track last processed value (timestamp, ID) and load only new/changed records.

**Characteristics:**
- Requires surrogate key or timestamp column
- Store high water mark between runs
- Only captures inserts and updates (not deletes)
- Efficient for append-mostly scenarios

**When to Use:**
- Large tables with timestamp columns
- Append-heavy workloads (logs, events)
- Source supports filtering by timestamp/ID
- Deletes are rare or acceptable to miss

**Implementation:**
- Pipeline parameters for LastRunTime
- Lookup Activity to get max timestamp
- Set Variable to store for next run
- Copy Activity with source query filter

**SQL Example:**
```sql
SELECT * FROM SourceTable
WHERE ModifiedDate > '@{pipeline().parameters.LastRunTime}'
```

### Database CDC (Change Data Capture)

**Description:** Leverage database CDC features to capture INSERT/UPDATE/DELETE operations.

**Characteristics:**
- Tracks all DML operations (inserts, updates, deletes)
- Source database maintains change tables
- Near-real-time capture possible
- Minimal impact on source system

**When to Use:**
- Source database supports CDC (SQL Server, Oracle, MySQL)
- Need to track deletes
- Near-real-time data required
- Complete audit trail needed

**Database Support:**
- SQL Server: Built-in CDC feature
- Oracle: Oracle GoldenGate, LogMiner
- PostgreSQL: Logical replication slots
- MySQL: Binary log (binlog)

**FDF Implementation:**
- Enable CDC on source tables
- Use specialized connectors (Azure Data Factory CDC connectors)
- Copy Activity reads from CDC tables
- Merge/Upsert logic in target

### Delta/Diff Pattern

**Description:** Compare current source snapshot with previous snapshot to identify changes.

**Characteristics:**
- Requires storing previous snapshot
- Can detect all change types
- Higher storage requirements
- Processing overhead for comparison

**When to Use:**
- Source doesn't support CDC or timestamps
- Need complete change detection
- Batch processing acceptable
- Storage cost acceptable

**Implementation Steps:**
1. Extract full current snapshot
2. Compare with previous snapshot (stored in delta lake)
3. Identify inserts, updates, deletes
4. Apply changes to target
5. Replace previous snapshot with current

### Streaming CDC Pattern

**Description:** Continuous capture of changes via event streams.

**Characteristics:**
- Real-time or near-real-time
- Event-driven architecture
- Requires streaming infrastructure
- Low latency

**When to Use:**
- Sub-second latency required
- Event-driven downstream consumers
- Real-time analytics
- Modern cloud-native architecture

**Technologies:**
- Azure Event Hubs
- Kafka
- Debezium
- Fabric Event Streams

---

## 3. Batch vs Stream Processing Patterns

### Batch Processing Pattern

**Description:** Process data in discrete, scheduled chunks/windows.

**Characteristics:**
- Scheduled execution (hourly, daily, weekly)
- Process complete datasets or time windows
- Higher latency, higher throughput
- Optimized for large volumes
- Easier error handling and recovery

**When to Use:**
- Periodic reporting requirements
- Large historical data processing
- Complex aggregations and joins
- Cost optimization (scheduled compute)
- Data available in batches
- Latency tolerance > 15 minutes

**Advantages:**
- Higher throughput per cost unit
- Simpler error handling and retry
- Well-established patterns and tools
- Easier to reason about state
- Better for complex aggregations

**Disadvantages:**
- Higher latency (minutes to hours)
- All-or-nothing processing
- Resource spikes during batch windows
- Delayed insights

**FDF Implementation:**
- Scheduled triggers (daily, hourly)
- Tumbling window triggers for regular intervals
- Copy Activity for data movement
- Data Flow for batch transformations
- ForEach for parallel batch processing

**Weather Pipeline Analysis:**
The provided pipeline (`pipeline-content.json`) is a **batch pattern**:
- Processes entire CSV file in one execution
- No streaming or micro-batch capabilities
- Suitable for periodic weather data updates

### Stream Processing Pattern

**Description:** Process data continuously as it arrives, record-by-record or micro-batch.

**Characteristics:**
- Continuous execution
- Event-driven triggers
- Low latency (milliseconds to seconds)
- Incremental processing
- Stateful computations for aggregations

**When to Use:**
- Real-time alerting and monitoring
- Fraud detection
- IoT sensor data processing
- User behavior tracking
- Financial transactions
- Latency requirements < 15 minutes

**Advantages:**
- Low latency insights
- Continuous processing (no batch windows)
- Event-driven responsiveness
- Gradual resource consumption
- Better for time-series data

**Disadvantages:**
- More complex error handling
- State management complexity
- Higher per-record processing cost
- Eventual consistency challenges
- Requires streaming infrastructure

**FDF/Fabric Implementation:**
- Event-driven triggers
- Fabric Event Streams (Kafka-based)
- Streaming Data Flow (limited support)
- Azure Stream Analytics integration
- Fabric Real-Time Analytics

### Micro-Batch Pattern (Lambda Architecture)

**Description:** Hybrid approach - stream processing for real-time with batch for accuracy.

**Characteristics:**
- Two parallel processing paths
- Speed layer (stream) + Batch layer
- Serving layer merges results
- Balances latency and accuracy

**When to Use:**
- Need both real-time and accurate historical views
- Complex aggregations not suitable for streaming
- Reprocessing requirements
- Best-of-both-worlds scenarios

**Challenges:**
- Complex architecture (two codebases)
- Data synchronization
- Higher operational overhead

### Kappa Architecture (Streaming-Only)

**Description:** Everything as a stream, including batch workloads.

**Characteristics:**
- Single processing paradigm
- Replay capability for reprocessing
- Event sourcing foundation
- Modern cloud-native approach

---

## 4. Data Lake vs Data Warehouse Patterns

### Data Warehouse Pattern

**Definition:** Centralized repository of integrated, structured data optimized for analytics.

**Characteristics:**
- Schema-on-write (predefined schema)
- Structured data (relational)
- Optimized for SQL queries
- Star/snowflake schemas
- Curated and transformed data
- Business-friendly terminology

**When to Use:**
- Well-defined reporting requirements
- Structured/semi-structured data only
- Business user self-service analytics
- Governance and data quality critical
- Historical trend analysis
- OLAP workloads

**Architecture:**
- Staging → Integration → Presentation layers
- Dimensional modeling (facts and dimensions)
- Slowly Changing Dimensions (SCD)
- Aggregation tables for performance

**Microsoft Fabric Implementation:**
- Fabric SQL Database (FDB)
- Synapse Data Warehouse
- Power BI datasets built on warehouse
- Direct Lake mode for optimal performance

**Advantages:**
- Fast query performance (optimized schemas)
- Business-friendly structure
- Strong data governance
- Mature tooling and expertise
- Consistent definitions (single source of truth)

**Disadvantages:**
- Schema changes are expensive
- Limited to structured data
- Higher latency for data availability
- Not suitable for unstructured data

**Weather Pipeline Fit:**
The target is `stage.WxReading` in a SQL database - this is a **data warehouse pattern**:
- Structured table with defined schema
- Staging layer (stage schema)
- Likely leads to dimensional model

### Data Lake Pattern

**Definition:** Scalable storage for raw data in native format (structured, semi-structured, unstructured).

**Characteristics:**
- Schema-on-read (apply schema when reading)
- All data types (CSV, JSON, Parquet, images, video)
- Scalable and cost-effective storage
- Data stored in zones/layers (bronze, silver, gold)
- ELT processing paradigm

**When to Use:**
- Diverse data sources and formats
- Exploratory analytics and data science
- Unstructured/semi-structured data (logs, JSON, XML)
- Cost-effective long-term storage
- Machine learning use cases
- "Store now, figure out later" scenarios

**Architecture (Medallion):**
1. **Bronze (Raw):** Ingested data in original format
2. **Silver (Cleansed):** Validated, deduplicated, enriched
3. **Gold (Curated):** Business-level aggregates, optimized

**Microsoft Fabric Implementation:**
- OneLake (unified data lake)
- Lakehouse (combination of lake + warehouse capabilities)
- Delta Lake format (ACID transactions)
- Parquet for efficient storage

**Advantages:**
- Store any data type
- Lower storage costs
- Flexibility for changing requirements
- Support for data science and ML
- Raw data preserved for reprocessing

**Disadvantages:**
- Can become "data swamp" without governance
- Slower query performance on raw data
- Requires data engineering expertise
- Schema management complexity

### Lakehouse Pattern (Hybrid)

**Definition:** Combines data lake flexibility with data warehouse performance.

**Characteristics:**
- Delta Lake/Iceberg table formats
- ACID transactions on data lake
- SQL query capabilities
- Schema enforcement options
- Best of both worlds

**When to Use:**
- Modern cloud-native architectures
- Need both flexibility and performance
- Data science AND business analytics
- Microsoft Fabric environments

**Microsoft Fabric Lakehouse:**
- SQL endpoint for querying
- Spark for transformations
- Direct Lake for Power BI
- Medallion architecture support

**Advantages:**
- Single copy of data (no duplication)
- Flexible schema evolution
- Cost-effective storage with query performance
- Unified governance

**Disadvantages:**
- Newer technology (less mature)
- Learning curve for teams
- Requires modern tooling

### Data Lake vs Warehouse Decision Matrix

| Criteria | Data Lake | Data Warehouse | Lakehouse |
|----------|-----------|----------------|-----------|
| **Data Types** | All types | Structured | All types |
| **Schema** | Schema-on-read | Schema-on-write | Flexible |
| **Cost** | Low | Higher | Medium |
| **Query Performance** | Variable | Optimized | Good |
| **Use Cases** | Data science, ML | BI, reporting | Both |
| **Users** | Data engineers, scientists | Business analysts | Both |
| **Governance** | Complex | Mature | Evolving |
| **Fabric Service** | OneLake | SQL Database | Lakehouse |

---

## Weather Pipeline Pattern Analysis

### Current Implementation (pipeline-content.json)

**Observed Patterns:**
1. **ETL vs ELT:** Minimal ETL (mostly ELT)
   - Simple column name mapping during copy
   - No complex transformations
   - Data loaded to SQL database for transformation
   - **Classification:** Light ETL / Primarily ELT

2. **CDC Pattern:** Full Load
   - `preCopyScript: "Truncate Table stage.WxReading;"`
   - Complete dataset replaced each run
   - No incremental logic
   - **Classification:** Full Refresh Pattern

3. **Processing Model:** Batch
   - Processes entire CSV file
   - No streaming capabilities
   - Likely scheduled trigger
   - **Classification:** Batch Processing

4. **Storage Pattern:** Data Warehouse Staging
   - Target: `stage.WxReading` (staging schema)
   - SQL Database destination
   - Structured table
   - **Classification:** Data Warehouse (Staging Layer)

### Recommendations for Weather Pipeline

**Current State: Appropriate for:**
- Small to medium weather data files
- Periodic updates (hourly/daily)
- Historical reporting
- Structured weather metrics

**Consider Enhancements:**

1. **Incremental Loading (if data volume grows):**
   ```sql
   -- Instead of truncate, use incremental pattern
   WHERE Timestamp > @LastLoadTime
   ```

2. **Lakehouse Pattern (for flexibility):**
   - Load raw CSV to Bronze layer (OneLake)
   - Transform to Silver (cleansed weather data)
   - Create Gold aggregates (daily/hourly summaries)

3. **Streaming (for real-time weather):**
   - If weather station sends real-time data
   - Use Event Streams → Real-Time Analytics
   - Low latency alerts (severe weather)

4. **Hybrid Approach (Recommended):**
   ```
   Weather Station → Event Hub (streaming) → Lakehouse Bronze (raw)
                                           ↓
                                    Spark Transformations
                                           ↓
                                    Silver Layer (cleansed)
                                           ↓
                                    SQL Database (aggregated)
                                           ↓
                                    Power BI (reporting)
   ```

---

## Pattern Selection Guidelines

### Decision Framework

1. **Start with Data Characteristics:**
   - Volume (GB/TB/PB)
   - Velocity (batch/real-time)
   - Variety (structured/unstructured)
   - Veracity (quality requirements)

2. **Consider Business Requirements:**
   - Latency tolerance
   - Accuracy requirements
   - Query patterns
   - User personas

3. **Evaluate Technical Constraints:**
   - Source system capabilities
   - Target system capabilities
   - Budget
   - Team expertise

4. **Apply Patterns:**
   - ETL/ELT based on target capabilities
   - CDC based on change tracking needs
   - Batch/Stream based on latency requirements
   - Lake/Warehouse based on data types and use cases

### Modern Data Stack Recommendation (Microsoft Fabric)

```
Source Systems → Fabric Data Factory (ingestion)
                        ↓
                 OneLake Lakehouse
                 (Bronze → Silver → Gold)
                        ↓
            SQL Analytics Endpoint (optional)
                        ↓
                  Power BI Direct Lake
```

**Pattern Combination:**
- **ELT** (leverage Fabric compute)
- **CDC** (incremental where possible, full for small datasets)
- **Batch + Stream** (Kappa for unified processing)
- **Lakehouse** (medallion architecture)

---

## Key Takeaways

1. **No Single Right Answer:** Pattern selection depends on specific requirements
2. **Patterns Combine:** Real-world solutions use multiple patterns together
3. **Evolution:** Start simple, evolve as needs grow
4. **Microsoft Fabric Paradigm:** ELT + Lakehouse + Medallion is the modern default
5. **Weather Pipeline:** Current implementation is appropriate for its scale; consider medallion architecture for future enhancements

---

## References and Further Reading

- **ETL/ELT:** "The Data Warehouse Toolkit" by Ralph Kimball
- **CDC:** Martin Kleppmann's "Designing Data-Intensive Applications"
- **Batch vs Stream:** "Streaming Systems" by Tyler Akidau
- **Data Lake:** "The Enterprise Big Data Lake" by Alex Gorelik
- **Microsoft Fabric:** [Microsoft Fabric Documentation](https://learn.microsoft.com/en-us/fabric/)
- **Medallion Architecture:** Databricks Delta Lake Best Practices

---

**Document Status:** Complete
**Next Steps:** Create decision matrix in deliverables folder
**Author:** Claude Code (Session 1C)
