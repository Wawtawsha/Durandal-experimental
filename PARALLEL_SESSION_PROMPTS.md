# Ready-to-Use Parallel Session Prompts

Copy and paste these into separate Claude Code Web sessions:

---

## 🟢 WAVE 1 - Start These Immediately (3 Sessions)

### Session 1A - Pattern Fundamentals (Gang of Four)
```
I need you to work on a specific sub-task for the PASS Data Community Summit project.

Repository: https://github.com/Wawtawsha/PASS
Task ID: TASK-001A
Branch: task-001a-gof-patterns

Your assignment: Research how Gang of Four design patterns can be applied to data pipeline architectures. Focus on:
- Factory Pattern (for creating different pipeline types)
- Builder Pattern (for constructing complex pipelines)
- Template Method (for defining pipeline skeletons)
- Strategy Pattern (for interchangeable pipeline components)

Instructions:
1. Clone the repo and create your branch
2. Read PASS_ORCHESTRATION.md and pipeline-content.json
3. Document findings in /documentation/task-001/gof-patterns.md
4. Create a pattern catalog in /deliverables/task-001/gof-catalog.md
5. Include code examples showing how each pattern maps to FDF pipelines

Do NOT wait for other sessions. Start immediately.
```

### Session 1B - Pattern Fundamentals (Integration)
```
I need you to work on a specific sub-task for the PASS Data Community Summit project.

Repository: https://github.com/Wawtawsha/PASS
Task ID: TASK-001B
Branch: task-001b-integration-patterns

Your assignment: Research Enterprise Integration Patterns applicable to FDF pipelines. Focus on:
- Pipes and Filters (sequential processing)
- Message Router (conditional flows)
- Content Enricher (data augmentation)
- Splitter/Aggregator (parallel processing)

Instructions:
1. Clone the repo and create your branch
2. Read PASS_ORCHESTRATION.md and pipeline-content.json
3. Document findings in /documentation/task-001/integration-patterns.md
4. Create pattern templates in /deliverables/task-001/eip-templates.md
5. Map the sample pipeline to these patterns

Do NOT wait for other sessions. Start immediately.
```

### Session 1C - Pattern Fundamentals (Data-Specific)
```
I need you to work on a specific sub-task for the PASS Data Community Summit project.

Repository: https://github.com/Wawtawsha/PASS
Task ID: TASK-001C
Branch: task-001c-data-patterns

Your assignment: Research data pipeline specific patterns. Focus on:
- ETL vs ELT patterns
- Change Data Capture (CDC) patterns
- Batch vs Stream processing patterns
- Data Lake vs Data Warehouse patterns

Instructions:
1. Clone the repo and create your branch
2. Read PASS_ORCHESTRATION.md and pipeline-content.json
3. Document findings in /documentation/task-001/data-patterns.md
4. Create decision matrix in /deliverables/task-001/pattern-selection.md
5. Analyze which patterns fit the weather data pipeline

Do NOT wait for other sessions. Start immediately.
```

---

## 🟡 WAVE 2 - Start After Wave 1 Completes (2 Sessions)

### Session 2A - Industry Standards (Microsoft/Azure)
```
I need you to work on TASK-002A for the PASS project.

Repository: https://github.com/Wawtawsha/PASS
Prerequisite: TASK-001 branches must be merged
Task ID: TASK-002A
Branch: task-002a-microsoft-standards

Your assignment: Research Microsoft and Azure-specific best practices for data pipeline patterns. Focus on:
- Microsoft Fabric Data Factory guidelines
- Azure architecture patterns
- Microsoft's Cloud Adoption Framework for data
- Well-Architected Framework data principles

Instructions:
1. Pull latest main branch (should have TASK-001 merged)
2. Create your branch
3. Document in /documentation/task-002/microsoft-standards.md
4. Create compliance checklist in /deliverables/task-002/azure-checklist.md
5. Map TASK-001 patterns to Microsoft standards
```

### Session 2B - Industry Standards (General ETL)
```
I need you to work on TASK-002B for the PASS project.

Repository: https://github.com/Wawtawsha/PASS
Prerequisite: TASK-001 branches must be merged
Task ID: TASK-002B
Branch: task-002b-etl-standards

Your assignment: Research general industry ETL/ELT standards. Focus on:
- Data Management Body of Knowledge (DMBOK)
- The Data Warehouse Toolkit patterns
- Modern Data Stack principles
- DataOps best practices

Instructions:
1. Pull latest main branch (should have TASK-001 merged)
2. Create your branch
3. Document in /documentation/task-002/etl-standards.md
4. Create standards matrix in /deliverables/task-002/standards-matrix.md
5. Compare with patterns from TASK-001
```

---

## 🔴 WAVE 3 - Start After Wave 2 (3 Sessions)

### Session 3A - Pipeline Structure Analysis
```
I need you to work on TASK-003A analyzing the FDF pipeline structure.

Repository: https://github.com/Wawtawsha/PASS
Prerequisites: TASK-001 and TASK-002 must be complete
Task ID: TASK-003A
Branch: task-003a-structure-analysis

Your assignment: Deep dive into pipeline-content.json structure. Focus on:
- Identifying all component types
- Mapping JSON structure to logical components
- Creating a pipeline anatomy diagram
- Identifying reusable vs unique elements

Build on the patterns identified in TASK-001 and standards from TASK-002.
```

### Session 3B - Parameter Extraction
```
I need you to work on TASK-003B identifying parameterizable elements.

Repository: https://github.com/Wawtawsha/PASS
Prerequisites: TASK-001 and TASK-002 must be complete
Task ID: TASK-003B
Branch: task-003b-parameter-extraction

Your assignment: Identify all parameterizable elements in the pipeline. Focus on:
- Connection strings and IDs
- Table/schema names
- Column mappings
- Configuration values
- Runtime parameters

Create a parameter catalog and extraction rules.
```

### Session 3C - Pattern Mapping
```
I need you to work on TASK-003C mapping pipeline to patterns.

Repository: https://github.com/Wawtawsha/PASS
Prerequisites: TASK-001 and TASK-002 must be complete
Task ID: TASK-003C
Branch: task-003c-pattern-mapping

Your assignment: Map the weather pipeline to identified patterns. Focus on:
- Which patterns from TASK-001 apply
- How to decompose the pipeline into pattern components
- Creating a pattern-based representation
- Identifying pattern boundaries

Create a visual mapping and pattern application guide.
```

---

## 📊 Progress Tracking Commands

For the session coordinator (you), track progress with:

```bash
# Check all branches across sessions
git fetch --all
git branch -r

# See latest commits from each session
git log --oneline --graph --all --decorate

# Check specific session progress
git log origin/task-001a-gof-patterns --oneline -5

# Merge completed wave
git checkout main
git merge origin/task-001a-gof-patterns origin/task-001b-integration-patterns origin/task-001c-data-patterns
```

---

## 🔄 Merge Instructions After Each Wave

```bash
# After Wave 1 completes
git checkout main
git pull origin main
git merge origin/task-001a-gof-patterns
git merge origin/task-001b-integration-patterns
git merge origin/task-001c-data-patterns
git push origin main

# Create consolidated report
echo "# TASK-001 Consolidated Findings" > documentation/task-001/COMPLETE.md
cat documentation/task-001/*.md >> documentation/task-001/COMPLETE.md
git add .
git commit -m "[TASK-001] Consolidated parallel session findings"
git push origin main
```

Then notify Wave 2 sessions they can begin.