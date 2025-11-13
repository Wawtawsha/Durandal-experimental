# Enterprise Integration Pattern Templates for FDF

**Task ID:** TASK-001B
**Purpose:** Reusable templates for implementing EIP patterns in Microsoft Fabric Data Factory
**Date:** 2025-11-13

## How to Use These Templates

Each template is provided in JSON format and can be adapted to your specific use case by:
1. Replacing placeholder values (marked with `{PLACEHOLDER}` or `@parameters()`)
2. Adjusting activity names to match your naming conventions
3. Customizing type properties for your data sources and sinks
4. Adding error handling and monitoring as needed

---

## Template 1: Pipes and Filters Pattern

### Use Case
Sequential ETL processing with multiple transformation stages.

### Template Structure

```json
{
  "name": "{PIPELINE_NAME}-PipesAndFilters",
  "properties": {
    "description": "Implements Pipes and Filters pattern for sequential data processing",
    "parameters": {
      "sourceContainer": {
        "type": "string",
        "defaultValue": "{SOURCE_CONTAINER}"
      },
      "targetSchema": {
        "type": "string",
        "defaultValue": "{TARGET_SCHEMA}"
      },
      "targetTable": {
        "type": "string",
        "defaultValue": "{TARGET_TABLE}"
      }
    },
    "activities": [
      {
        "name": "Filter1-Extract",
        "description": "Extract data from source system",
        "type": "Copy",
        "dependsOn": [],
        "typeProperties": {
          "source": {
            "type": "{SOURCE_TYPE}",
            "storeSettings": {
              "type": "{STORE_SETTINGS_TYPE}"
            }
          },
          "sink": {
            "type": "ParquetSink",
            "storeSettings": {
              "type": "AzureBlobFSWriteSettings",
              "copyBehavior": "PreserveHierarchy"
            }
          }
        },
        "outputs": [
          {
            "referenceName": "StageDataset",
            "type": "DatasetReference"
          }
        ]
      },
      {
        "name": "Filter2-Transform",
        "description": "Apply business transformations",
        "type": "DataFlow",
        "dependsOn": [
          {
            "activity": "Filter1-Extract",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "dataflow": {
            "referenceName": "{TRANSFORMATION_DATAFLOW}",
            "type": "DataFlowReference"
          }
        }
      },
      {
        "name": "Filter3-Validate",
        "description": "Data quality validation",
        "type": "Validation",
        "dependsOn": [
          {
            "activity": "Filter2-Transform",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "dataset": {
            "referenceName": "TransformedDataset",
            "type": "DatasetReference"
          },
          "timeout": "0.01:00:00",
          "minimumSize": 1
        }
      },
      {
        "name": "Filter4-Load",
        "description": "Load to target destination",
        "type": "Copy",
        "dependsOn": [
          {
            "activity": "Filter3-Validate",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "source": {
            "type": "ParquetSource"
          },
          "sink": {
            "type": "FabricSqlDatabaseSink",
            "preCopyScript": "TRUNCATE TABLE @{pipeline().parameters.targetSchema}.@{pipeline().parameters.targetTable};",
            "writeBehavior": "insert"
          }
        }
      }
    ]
  }
}
```

### Parameterization Guide

| Parameter | Description | Example |
|-----------|-------------|---------|
| `{PIPELINE_NAME}` | Descriptive name for the pipeline | `WeatherDataIngestion` |
| `{SOURCE_CONTAINER}` | Source storage container | `raw-data` |
| `{TARGET_SCHEMA}` | Destination schema | `stage` |
| `{TARGET_TABLE}` | Destination table | `WeatherReadings` |
| `{SOURCE_TYPE}` | Source connector type | `DelimitedTextSource` |
| `{TRANSFORMATION_DATAFLOW}` | Name of Data Flow | `TransformWeatherData` |

---

## Template 2: Message Router Pattern (Content-Based Routing)

### Use Case
Route data to different processing paths based on content or metadata.

### Template Structure

```json
{
  "name": "{PIPELINE_NAME}-MessageRouter",
  "properties": {
    "description": "Implements Message Router pattern for conditional data routing",
    "parameters": {
      "routingThreshold": {
        "type": "int",
        "defaultValue": 1000000
      },
      "fileType": {
        "type": "string",
        "defaultValue": "CSV"
      }
    },
    "activities": [
      {
        "name": "GetMetadata-Router",
        "description": "Inspect message/file properties",
        "type": "GetMetadata",
        "dependsOn": [],
        "typeProperties": {
          "dataset": {
            "referenceName": "{SOURCE_DATASET}",
            "type": "DatasetReference"
          },
          "fieldList": ["size", "itemName", "lastModified"]
        }
      },
      {
        "name": "Route-BySize",
        "description": "Route based on file size",
        "type": "IfCondition",
        "dependsOn": [
          {
            "activity": "GetMetadata-Router",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "expression": {
            "value": "@greater(activity('GetMetadata-Router').output.size, pipeline().parameters.routingThreshold)",
            "type": "Expression"
          },
          "ifTrueActivities": [
            {
              "name": "ProcessLargeFile-Streaming",
              "type": "DataFlow",
              "typeProperties": {
                "dataflow": {
                  "referenceName": "StreamingDataFlow",
                  "type": "DataFlowReference"
                },
                "compute": {
                  "coreCount": 16,
                  "computeType": "MemoryOptimized"
                }
              }
            }
          ],
          "ifFalseActivities": [
            {
              "name": "ProcessSmallFile-Batch",
              "type": "Copy",
              "typeProperties": {
                "source": {
                  "type": "{SOURCE_TYPE}"
                },
                "sink": {
                  "type": "{SINK_TYPE}"
                }
              }
            }
          ]
        }
      },
      {
        "name": "Route-ByFileType",
        "description": "Multi-path routing based on file type",
        "type": "Switch",
        "dependsOn": [],
        "typeProperties": {
          "on": {
            "value": "@pipeline().parameters.fileType",
            "type": "Expression"
          },
          "cases": [
            {
              "value": "CSV",
              "activities": [
                {
                  "name": "Process-CSV",
                  "type": "ExecutePipeline",
                  "typeProperties": {
                    "pipeline": {
                      "referenceName": "ProcessCSVPipeline",
                      "type": "PipelineReference"
                    },
                    "waitOnCompletion": true
                  }
                }
              ]
            },
            {
              "value": "JSON",
              "activities": [
                {
                  "name": "Process-JSON",
                  "type": "ExecutePipeline",
                  "typeProperties": {
                    "pipeline": {
                      "referenceName": "ProcessJSONPipeline",
                      "type": "PipelineReference"
                    },
                    "waitOnCompletion": true
                  }
                }
              ]
            },
            {
              "value": "Parquet",
              "activities": [
                {
                  "name": "Process-Parquet",
                  "type": "ExecutePipeline",
                  "typeProperties": {
                    "pipeline": {
                      "referenceName": "ProcessParquetPipeline",
                      "type": "PipelineReference"
                    },
                    "waitOnCompletion": true
                  }
                }
              ]
            }
          ],
          "defaultActivities": [
            {
              "name": "Log-UnsupportedFormat",
              "type": "WebActivity",
              "typeProperties": {
                "url": "{LOGGING_ENDPOINT}",
                "method": "POST",
                "body": {
                  "error": "Unsupported file format",
                  "fileType": "@{pipeline().parameters.fileType}",
                  "timestamp": "@utcnow()"
                }
              }
            }
          ]
        }
      }
    ]
  }
}
```

### Routing Decision Patterns

**Quality-Based Routing:**
```json
{
  "expression": {
    "value": "@and(not(empty(activity('ValidateData').output)), equals(activity('ValidateData').output.validationStatus, 'PASSED'))",
    "type": "Expression"
  },
  "ifTrueActivities": ["LoadToProduction"],
  "ifFalseActivities": ["QuarantineData"]
}
```

**Time-Based Routing:**
```json
{
  "expression": {
    "value": "@less(int(formatDateTime(utcnow(), 'HH')), 6)",
    "type": "Expression"
  },
  "ifTrueActivities": ["ProcessAsLowPriority"],
  "ifFalseActivities": ["ProcessAsHighPriority"]
}
```

---

## Template 3: Content Enricher Pattern

### Use Case
Augment data with additional context from reference sources.

### Template Structure

```json
{
  "name": "{PIPELINE_NAME}-ContentEnricher",
  "properties": {
    "description": "Implements Content Enricher pattern for data augmentation",
    "parameters": {
      "enrichmentSource": {
        "type": "string",
        "defaultValue": "{ENRICHMENT_TABLE}"
      }
    },
    "activities": [
      {
        "name": "Extract-BaseData",
        "description": "Get the base data to be enriched",
        "type": "Copy",
        "dependsOn": [],
        "typeProperties": {
          "source": {
            "type": "{SOURCE_TYPE}"
          },
          "sink": {
            "type": "ParquetSink"
          }
        }
      },
      {
        "name": "Enrich-WithDataFlow",
        "description": "Enrich data using Data Flow transformations",
        "type": "DataFlow",
        "dependsOn": [
          {
            "activity": "Extract-BaseData",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "dataflow": {
            "referenceName": "EnrichmentDataFlow",
            "type": "DataFlowReference",
            "parameters": {
              "enrichmentTable": "@pipeline().parameters.enrichmentSource"
            }
          }
        }
      }
    ]
  }
}
```

### Data Flow Enrichment Template

```json
{
  "name": "EnrichmentDataFlow",
  "properties": {
    "type": "MappingDataFlow",
    "typeProperties": {
      "sources": [
        {
          "name": "BaseData",
          "dataset": {
            "referenceName": "BaseDataset",
            "type": "DatasetReference"
          }
        },
        {
          "name": "ReferenceData",
          "dataset": {
            "referenceName": "ReferenceDimension",
            "type": "DatasetReference"
          }
        }
      ],
      "transformations": [
        {
          "name": "LookupEnrichment",
          "description": "Join with reference data",
          "type": "Join",
          "linkedServiceName": null,
          "typeProperties": {
            "leftStream": "BaseData",
            "rightStream": "ReferenceData",
            "joinType": "left",
            "joinCondition": {
              "type": "Expression",
              "value": "BaseData@{JOIN_KEY} == ReferenceData@{JOIN_KEY}"
            }
          }
        },
        {
          "name": "DerivedEnrichment",
          "description": "Calculate derived fields",
          "type": "DerivedColumn",
          "typeProperties": {
            "columns": [
              {
                "name": "FullName",
                "expression": "concat(FirstName, ' ', LastName)"
              },
              {
                "name": "ProcessedTimestamp",
                "expression": "currentTimestamp()"
              },
              {
                "name": "DataSource",
                "expression": "'FabricDataFactory'"
              },
              {
                "name": "{CALCULATED_FIELD}",
                "expression": "{CALCULATION_EXPRESSION}"
              }
            ]
          }
        },
        {
          "name": "SelectEnrichedFields",
          "description": "Choose fields for output",
          "type": "Select",
          "typeProperties": {
            "columns": [
              "BaseField1",
              "BaseField2",
              "EnrichedField1",
              "EnrichedField2",
              "CalculatedField"
            ]
          }
        }
      ],
      "sinks": [
        {
          "name": "EnrichedOutput",
          "dataset": {
            "referenceName": "EnrichedDataset",
            "type": "DatasetReference"
          }
        }
      ]
    }
  }
}
```

### Enrichment Patterns

**Lookup Activity Enrichment (Single Value):**
```json
{
  "name": "Lookup-Enrichment",
  "type": "Lookup",
  "typeProperties": {
    "source": {
      "type": "AzureSqlSource",
      "sqlReaderQuery": "SELECT ConfigValue FROM config.Settings WHERE ConfigKey = 'DefaultTimezone'"
    },
    "firstRowOnly": true
  }
}
```

**Aggregate Enrichment (Summary Statistics):**
```json
{
  "name": "Aggregate-Historical",
  "type": "Aggregate",
  "typeProperties": {
    "groupBy": ["StationID", "toDate(ReadingDate)"],
    "aggregates": [
      {
        "column": "AvgTemp_7Day",
        "function": "avg",
        "source": "Temperature",
        "rollingWindow": 7
      },
      {
        "column": "MaxTemp_Historical",
        "function": "max",
        "source": "Temperature"
      }
    ]
  }
}
```

---

## Template 4: Splitter/Aggregator Pattern

### Use Case
Parallel processing of partitioned data with result consolidation.

### Splitter Template

```json
{
  "name": "{PIPELINE_NAME}-Splitter",
  "properties": {
    "description": "Implements Splitter pattern for parallel processing",
    "parameters": {
      "fileList": {
        "type": "array",
        "defaultValue": []
      },
      "parallelism": {
        "type": "int",
        "defaultValue": 5
      }
    },
    "activities": [
      {
        "name": "Get-FileList",
        "description": "Discover files to process",
        "type": "GetMetadata",
        "dependsOn": [],
        "typeProperties": {
          "dataset": {
            "referenceName": "{SOURCE_DATASET}",
            "type": "DatasetReference"
          },
          "fieldList": ["childItems"],
          "storeSettings": {
            "recursive": true,
            "enablePartitionDiscovery": false
          }
        }
      },
      {
        "name": "Split-ForEach",
        "description": "Process each file in parallel",
        "type": "ForEach",
        "dependsOn": [
          {
            "activity": "Get-FileList",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "items": {
            "value": "@activity('Get-FileList').output.childItems",
            "type": "Expression"
          },
          "isSequential": false,
          "batchCount": "@pipeline().parameters.parallelism",
          "activities": [
            {
              "name": "Process-Partition",
              "type": "ExecutePipeline",
              "typeProperties": {
                "pipeline": {
                  "referenceName": "ProcessSingleFile",
                  "type": "PipelineReference"
                },
                "waitOnCompletion": true,
                "parameters": {
                  "fileName": "@item().name",
                  "fileSize": "@item().size"
                }
              }
            }
          ]
        }
      }
    ]
  }
}
```

### Aggregator Template

```json
{
  "name": "{PIPELINE_NAME}-Aggregator",
  "properties": {
    "description": "Implements Aggregator pattern for result consolidation",
    "activities": [
      {
        "name": "Aggregate-Results",
        "type": "DataFlow",
        "typeProperties": {
          "dataflow": {
            "referenceName": "AggregationDataFlow",
            "type": "DataFlowReference"
          }
        }
      }
    ]
  }
}
```

### Data Flow Aggregation Template

```json
{
  "name": "AggregationDataFlow",
  "properties": {
    "type": "MappingDataFlow",
    "typeProperties": {
      "sources": [
        {
          "name": "PartitionResult1",
          "dataset": {"referenceName": "Partition1", "type": "DatasetReference"}
        },
        {
          "name": "PartitionResult2",
          "dataset": {"referenceName": "Partition2", "type": "DatasetReference"}
        },
        {
          "name": "PartitionResultN",
          "dataset": {"referenceName": "PartitionN", "type": "DatasetReference"}
        }
      ],
      "transformations": [
        {
          "name": "Union-AllPartitions",
          "description": "Combine all partition results",
          "type": "Union",
          "typeProperties": {
            "streams": [
              "PartitionResult1",
              "PartitionResult2",
              "PartitionResultN"
            ],
            "unionBy": "byName"
          }
        },
        {
          "name": "Deduplicate",
          "description": "Remove duplicates across partitions",
          "type": "Aggregate",
          "typeProperties": {
            "groupBy": ["{PRIMARY_KEY}"],
            "aggregates": [
              {
                "column": "ProcessedTimestamp",
                "function": "max"
              }
            ]
          }
        },
        {
          "name": "Calculate-Summary",
          "description": "Generate aggregate statistics",
          "type": "Aggregate",
          "typeProperties": {
            "groupBy": ["{DIMENSION_FIELDS}"],
            "aggregates": [
              {
                "column": "TotalRecords",
                "function": "count"
              },
              {
                "column": "AvgValue",
                "function": "avg",
                "source": "{METRIC_FIELD}"
              },
              {
                "column": "SumValue",
                "function": "sum",
                "source": "{METRIC_FIELD}"
              }
            ]
          }
        }
      ],
      "sinks": [
        {
          "name": "ConsolidatedResults",
          "dataset": {
            "referenceName": "AggregatedDataset",
            "type": "DatasetReference"
          }
        }
      ]
    }
  }
}
```

### Dynamic Partitioning Template

```json
{
  "name": "Dynamic-Splitter",
  "description": "Split based on calculated partitions",
  "typeProperties": {
    "items": {
      "value": "@range(0, div(pipeline().parameters.totalRows, pipeline().parameters.partitionSize))",
      "type": "Expression"
    },
    "isSequential": false,
    "activities": [
      {
        "name": "Process-Range",
        "type": "Copy",
        "typeProperties": {
          "source": {
            "type": "{SOURCE_TYPE}",
            "additionalProperties": {
              "offset": "@mul(item(), pipeline().parameters.partitionSize)",
              "limit": "@pipeline().parameters.partitionSize"
            }
          }
        }
      }
    ]
  }
}
```

---

## Composite Pattern Template

### Use Case
Combining multiple patterns for comprehensive pipeline architecture.

```json
{
  "name": "{PIPELINE_NAME}-Composite",
  "properties": {
    "description": "Composite pattern: Splitter → Pipes/Filters → Router → Enricher → Aggregator",
    "parameters": {
      "stationList": {
        "type": "array"
      },
      "qualityThreshold": {
        "type": "int",
        "defaultValue": 95
      }
    },
    "activities": [
      {
        "name": "SPLITTER-ByStation",
        "type": "ForEach",
        "dependsOn": [],
        "typeProperties": {
          "items": "@pipeline().parameters.stationList",
          "isSequential": false,
          "batchCount": 5,
          "activities": [
            {
              "name": "PIPELINE-ProcessStation",
              "type": "ExecutePipeline",
              "typeProperties": {
                "pipeline": {
                  "referenceName": "StationProcessingPipeline",
                  "type": "PipelineReference"
                },
                "parameters": {
                  "stationID": "@item().id"
                }
              }
            }
          ]
        }
      },
      {
        "name": "AGGREGATOR-Consolidate",
        "type": "DataFlow",
        "dependsOn": [
          {
            "activity": "SPLITTER-ByStation",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "dataflow": {
            "referenceName": "ConsolidateStationData",
            "type": "DataFlowReference"
          }
        }
      }
    ]
  }
}
```

### Station Processing Sub-Pipeline (Pipes/Filters + Router + Enricher)

```json
{
  "name": "StationProcessingPipeline",
  "properties": {
    "parameters": {
      "stationID": {
        "type": "string"
      }
    },
    "activities": [
      {
        "name": "FILTER1-Extract",
        "type": "Copy",
        "dependsOn": []
      },
      {
        "name": "ROUTER-QualityCheck",
        "type": "IfCondition",
        "dependsOn": [
          {
            "activity": "FILTER1-Extract",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "expression": {
            "value": "@greaterOrEquals(activity('FILTER1-Extract').output.dataQualityScore, pipeline().parameters.qualityThreshold)",
            "type": "Expression"
          },
          "ifTrueActivities": [
            {
              "name": "ENRICHER-AddContext",
              "type": "DataFlow",
              "typeProperties": {
                "dataflow": {
                  "referenceName": "EnrichWeatherData",
                  "type": "DataFlowReference"
                }
              }
            }
          ],
          "ifFalseActivities": [
            {
              "name": "FILTER2-Quarantine",
              "type": "Copy",
              "typeProperties": {
                "sink": {
                  "type": "ParquetSink",
                  "storeSettings": {
                    "folderPath": "quarantine"
                  }
                }
              }
            }
          ]
        }
      },
      {
        "name": "FILTER3-Load",
        "type": "Copy",
        "dependsOn": [
          {
            "activity": "ROUTER-QualityCheck",
            "dependencyConditions": ["Succeeded"]
          }
        ]
      }
    ]
  }
}
```

---

## Pattern Application Checklist

Before implementing a pattern, verify:

- [ ] Pattern matches the business requirement
- [ ] All placeholders replaced with actual values
- [ ] Parameters externalized for reusability
- [ ] Error handling added (try-catch, retry policies)
- [ ] Logging/monitoring configured
- [ ] Performance testing plan defined
- [ ] Documentation updated with pattern rationale

## Testing Templates

### Unit Test Template (Single Activity)

```json
{
  "name": "Test-{ACTIVITY_NAME}",
  "properties": {
    "activities": [
      {
        "name": "Run-Activity",
        "type": "{ACTIVITY_TYPE}",
        "typeProperties": {
          // Copy activity config from main pipeline
        }
      },
      {
        "name": "Validate-Output",
        "type": "Lookup",
        "dependsOn": [{"activity": "Run-Activity", "dependencyConditions": ["Succeeded"]}],
        "typeProperties": {
          "source": {
            "type": "AzureSqlSource",
            "sqlReaderQuery": "SELECT COUNT(*) as RecordCount FROM {OUTPUT_TABLE}"
          }
        }
      },
      {
        "name": "Assert-RecordCount",
        "type": "IfCondition",
        "dependsOn": [{"activity": "Validate-Output", "dependencyConditions": ["Succeeded"]}],
        "typeProperties": {
          "expression": {
            "value": "@greater(activity('Validate-Output').output.firstRow.RecordCount, 0)",
            "type": "Expression"
          },
          "ifFalseActivities": [
            {
              "name": "Test-Failed",
              "type": "Fail",
              "typeProperties": {
                "message": "Test failed: No records processed",
                "errorCode": "TEST_FAILURE"
              }
            }
          ]
        }
      }
    ]
  }
}
```

---

## Version Control and Documentation

### Pattern Metadata Template

Include this JSON object in pipeline annotations:

```json
{
  "annotations": [
    {
      "patternType": "Enterprise Integration Pattern",
      "patternName": "Pipes and Filters",
      "patternVersion": "1.0",
      "author": "{AUTHOR_NAME}",
      "created": "2025-11-13",
      "lastModified": "2025-11-13",
      "description": "Sequential ETL processing for weather data ingestion",
      "dependencies": ["WeatherSourceDataset", "StagingDatabase"],
      "relatedPatterns": ["Content Enricher", "Message Router"]
    }
  ]
}
```

---

## Summary

These templates provide a foundation for implementing Enterprise Integration Patterns in Microsoft Fabric Data Factory. Key principles:

1. **Consistency**: Use standard naming conventions and structure
2. **Parameterization**: Make patterns reusable across contexts
3. **Composition**: Combine patterns for complex workflows
4. **Testing**: Validate each pattern independently
5. **Documentation**: Maintain pattern metadata for governance

Use these templates as starting points, adapting them to your specific data integration requirements while maintaining the core pattern principles.
