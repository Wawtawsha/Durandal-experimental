# Gang of Four Design Patterns for Data Pipeline Architectures

## TASK-001A: Pattern Fundamentals Research

**Session ID:** Session 1A
**Focus:** Gang of Four (GoF) Design Patterns
**Date:** 2025-11-13

---

## Executive Summary

This document explores how classic Gang of Four design patterns can be applied to Microsoft Fabric Data Factory (FDF) pipeline architectures. By leveraging these proven software design patterns, we can create reusable, maintainable, and scalable data pipeline solutions.

The four patterns examined are:
1. **Factory Pattern** - Creating different pipeline types
2. **Builder Pattern** - Constructing complex pipelines
3. **Template Method Pattern** - Defining pipeline skeletons
4. **Strategy Pattern** - Interchangeable pipeline components

---

## 1. Factory Pattern for Data Pipelines

### Pattern Overview
The Factory Pattern provides an interface for creating objects without specifying their exact class. In data pipelines, this allows us to create different pipeline types based on runtime parameters or configuration.

### Application to FDF Pipelines

**Use Case: Pipeline Type Creation**
- Create different pipeline types (Copy, Transform, Orchestration, Hybrid)
- Select appropriate source/sink connectors based on configuration
- Instantiate proper activity types based on requirements

**Real-World Scenarios:**
- **Multi-Source Ingestion:** Factory determines whether to create a Blob Storage, SQL, or REST API source connector
- **Environment-Specific Pipelines:** Create dev, test, or prod pipeline variants with appropriate configurations
- **Activity Type Selection:** Based on operation type, create Copy, Dataflow, or Script activities

### Benefits for FDF
- **Flexibility:** Easy to add new pipeline types without modifying existing code
- **Encapsulation:** Pipeline creation logic is centralized
- **Parameterization:** Runtime decisions on pipeline structure
- **Testability:** Mock factories for testing different pipeline configurations

### Pattern Application to Sample Pipeline

Looking at `pipeline-content.json`:
- The Copy activity could be created by a `CopyActivityFactory`
- The source type (`DelimitedTextSource`) could be determined by a `SourceFactory`
- The sink type (`FabricSqlDatabaseSink`) could be created by a `SinkFactory`

---

## 2. Builder Pattern for Data Pipelines

### Pattern Overview
The Builder Pattern separates the construction of a complex object from its representation, allowing the same construction process to create different representations.

### Application to FDF Pipelines

**Use Case: Complex Pipeline Construction**
- Build pipelines step-by-step with multiple components
- Configure activities, dependencies, and parameters incrementally
- Create different pipeline variations using the same building process

**Real-World Scenarios:**
- **Multi-Activity Pipeline Construction:** Add activities one at a time with proper dependencies
- **Configuration Assembly:** Build source settings, sink settings, mappings, and policies separately
- **Conditional Pipeline Building:** Include or exclude activities based on requirements

### Benefits for FDF
- **Readability:** Pipeline construction code is clear and self-documenting
- **Flexibility:** Easy to create pipeline variations
- **Validation:** Validate at each step of construction
- **Immutability:** Build once, use many times

### Pattern Application to Sample Pipeline

The sample pipeline has multiple complex components that would benefit from builder pattern:

```
Pipeline Builder Flow:
1. Start with base Copy activity
2. Add source configuration:
   - Storage type (Blob)
   - Format settings (CSV)
   - Dataset settings (container, file, delimiters)
3. Add sink configuration:
   - Database type (Fabric SQL)
   - Pre-copy script
   - Write behavior
4. Add translator/mappings:
   - 14 column mappings
   - Type conversion settings
5. Add policy:
   - Timeout, retry settings
6. Build final activity
```

---

## 3. Template Method Pattern for Data Pipelines

### Pattern Overview
The Template Method Pattern defines the skeleton of an algorithm in a base class, letting subclasses override specific steps without changing the algorithm's structure.

### Application to FDF Pipelines

**Use Case: Pipeline Execution Framework**
- Define standard pipeline execution workflow
- Allow customization of specific steps
- Maintain consistent pipeline behavior across types

**Real-World Scenarios:**
- **Standard ETL Flow:** Extract → Validate → Transform → Load framework with customizable steps
- **Error Handling Template:** Consistent error handling with custom recovery logic
- **Data Quality Framework:** Standard quality checks with custom validation rules

### Benefits for FDF
- **Consistency:** All pipelines follow the same overall structure
- **Maintainability:** Changes to common logic apply to all pipelines
- **Standardization:** Enforces best practices and patterns
- **Extensibility:** Easy to add new pipeline types that follow the template

### Pattern Application to Sample Pipeline

The Copy activity follows a template structure:

```
Standard Copy Pipeline Template:
1. Initialize connection (must implement)
2. Read source data (customizable)
3. Apply pre-copy operations (optional - e.g., "Truncate Table")
4. Map/transform data (customizable - mappings)
5. Write to sink (customizable)
6. Handle errors (defined by policy)
7. Cleanup/finalize
```

Each pipeline type implements the specific steps while following the overall template.

---

## 4. Strategy Pattern for Data Pipelines

### Pattern Overview
The Strategy Pattern defines a family of algorithms, encapsulates each one, and makes them interchangeable. This lets the algorithm vary independently from clients that use it.

### Application to FDF Pipelines

**Use Case: Interchangeable Pipeline Components**
- Swap source/sink types without changing pipeline logic
- Use different transformation strategies
- Apply different error handling or retry strategies

**Real-World Scenarios:**
- **Source Strategy:** Switch between Blob Storage, ADLS, SQL, or REST sources
- **Transformation Strategy:** Apply different transformation logic (simple copy, complex dataflow)
- **Write Strategy:** Different write behaviors (insert, upsert, merge)
- **Retry Strategy:** Different retry policies based on activity type

### Benefits for FDF
- **Flexibility:** Easy to swap components at runtime
- **Decoupling:** Pipeline logic independent of specific implementations
- **Testability:** Test different strategies in isolation
- **Configuration-Driven:** Select strategies via parameters

### Pattern Application to Sample Pipeline

The sample pipeline demonstrates several strategy opportunities:

**Source Strategy:**
- Current: `AzureBlobStorageReadSettings`
- Could swap with: ADLS Gen2, SQL Database, REST API

**Sink Strategy:**
- Current: `FabricSqlDatabaseSink` with `insert` write behavior
- Could swap with: Lakehouse, Warehouse, or change to `upsert`

**Mapping Strategy:**
- Current: `TabularTranslator` with direct mappings
- Could swap with: Complex transformation dataflow

**Pre-Copy Strategy:**
- Current: `Truncate Table stage.WxReading`
- Could swap with: Delete with WHERE clause, Merge, or no pre-copy

---

## Integration of Patterns

These patterns work together in a data pipeline architecture:

1. **Factory + Strategy:** Factory creates pipelines with appropriate strategies
2. **Builder + Factory:** Builder uses factories to create pipeline components
3. **Template Method + Strategy:** Template defines workflow, strategies implement steps
4. **All Four Together:** Builder creates pipeline, Factory creates components, Template Method defines workflow, Strategy makes components swappable

---

## Mapping to FDF Pipeline Architecture

### Component-Level Mapping

| FDF Component | Applicable Patterns |
|--------------|-------------------|
| Pipeline Definition | Builder, Template Method |
| Activity Types | Factory, Strategy |
| Source Connectors | Factory, Strategy |
| Sink Connectors | Factory, Strategy |
| Transformations | Strategy, Template Method |
| Error Handling | Template Method, Strategy |
| Data Mappings | Builder, Strategy |

### Sample Pipeline Component Analysis

From `pipeline-content.json`:

**Activity Type: Copy**
- Factory Pattern: Creates Copy activity vs other types
- Template Method: Follows Copy activity workflow

**Source Configuration:**
- Builder Pattern: Constructs source with formatSettings + storeSettings + datasetSettings
- Strategy Pattern: DelimitedTextSource is interchangeable with other source types

**Sink Configuration:**
- Builder Pattern: Constructs sink with multiple properties
- Strategy Pattern: FabricSqlDatabaseSink interchangeable with other sinks

**Translator/Mappings:**
- Builder Pattern: Builds mapping list incrementally
- Template Method: Follows standard mapping workflow

---

## Pattern Selection Criteria

### When to Use Factory Pattern
- Need to create multiple types of pipelines or activities
- Pipeline type determined at runtime
- Want to centralize creation logic

### When to Use Builder Pattern
- Pipeline has many optional components
- Construction process is complex with multiple steps
- Need to create pipeline variations from same blueprint

### When to Use Template Method
- Standard workflow applies across multiple pipeline types
- Want to enforce consistent structure
- Need to allow customization of specific steps

### When to Use Strategy Pattern
- Need to swap components at runtime
- Multiple algorithms for same operation
- Want configuration-driven component selection

---

## Recommendations for FDF Pattern Implementation

1. **Start with Builder Pattern**
   - Most immediately applicable to complex pipeline construction
   - Improves code readability and maintainability

2. **Implement Factory for Activity Creation**
   - Centralize logic for creating different activity types
   - Enables dynamic pipeline generation

3. **Apply Template Method for Consistency**
   - Define standard pipeline execution frameworks
   - Ensure best practices are followed

4. **Use Strategy for Flexibility**
   - Make pipelines configuration-driven
   - Enable easy testing and modifications

---

## Next Steps

1. **Pattern Cataloging:** Create detailed pattern catalog with code examples
2. **Prototype Implementation:** Build sample implementations of each pattern
3. **Integration Standards:** Define how patterns work together
4. **Claude Instruction Engineering:** Design prompts for pattern-based pipeline generation

---

## Conclusion

Gang of Four design patterns provide a solid foundation for creating scalable, maintainable data pipeline architectures in Microsoft Fabric Data Factory. By applying these patterns:

- **Factory Pattern** enables flexible pipeline type creation
- **Builder Pattern** simplifies complex pipeline construction
- **Template Method** ensures consistent pipeline structure
- **Strategy Pattern** provides component interchangeability

These patterns, originally designed for object-oriented software, translate remarkably well to the declarative JSON structure of FDF pipelines, offering a robust framework for pipeline-as-code practices.
