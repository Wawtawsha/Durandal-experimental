# Gang of Four Pattern Catalog for FDF Pipelines

## TASK-001A Deliverable: Pattern Catalog with Code Examples

**Session ID:** Session 1A
**Purpose:** Provide implementable pattern templates for FDF pipeline generation
**Date:** 2025-11-13

---

## Pattern Catalog Overview

This catalog provides concrete code examples showing how to implement Gang of Four design patterns for Microsoft Fabric Data Factory pipelines. Each pattern includes:
- Pattern structure in pseudocode
- Python implementation examples
- JSON template mappings
- Application to the sample weather pipeline

---

## 1. Factory Pattern Implementation

### Pattern Structure

```python
# Abstract Factory Interface
class PipelineActivityFactory:
    """Abstract factory for creating pipeline activities"""

    def create_activity(self, activity_type: str, config: dict) -> dict:
        """Create activity based on type"""
        raise NotImplementedError

# Concrete Factories
class CopyActivityFactory(PipelineActivityFactory):
    """Factory for creating Copy activities"""

    def create_activity(self, activity_type: str, config: dict) -> dict:
        return {
            "type": "Copy",
            "name": config.get("name", "Copy data"),
            "typeProperties": self._build_type_properties(config),
            "policy": self._build_policy(config),
            "dependsOn": config.get("dependsOn", [])
        }

    def _build_type_properties(self, config: dict) -> dict:
        return {
            "source": self._create_source(config["source"]),
            "sink": self._create_sink(config["sink"]),
            "translator": self._create_translator(config.get("mappings")),
            "enableStaging": config.get("enableStaging", False)
        }

    def _create_source(self, source_config: dict) -> dict:
        source_factory = SourceFactory()
        return source_factory.create(source_config)

    def _create_sink(self, sink_config: dict) -> dict:
        sink_factory = SinkFactory()
        return sink_factory.create(sink_config)

    def _create_translator(self, mappings: list) -> dict:
        if not mappings:
            return {}
        return {
            "type": "TabularTranslator",
            "mappings": mappings,
            "typeConversion": True,
            "typeConversionSettings": {
                "allowDataTruncation": True,
                "treatBooleanAsNumber": False
            }
        }

    def _build_policy(self, config: dict) -> dict:
        return {
            "timeout": config.get("timeout", "0.12:00:00"),
            "retry": config.get("retry", 0),
            "retryIntervalInSeconds": config.get("retryInterval", 30),
            "secureInput": False,
            "secureOutput": False
        }


class DataflowActivityFactory(PipelineActivityFactory):
    """Factory for creating Dataflow activities"""

    def create_activity(self, activity_type: str, config: dict) -> dict:
        return {
            "type": "Dataflow",
            "name": config.get("name", "Transform data"),
            "typeProperties": {
                "dataflow": {
                    "referenceName": config["dataflowName"]
                },
                "compute": config.get("compute", {})
            }
        }


class SourceFactory:
    """Factory for creating source configurations"""

    SOURCE_TYPES = {
        "blob": "AzureBlobStorageReadSettings",
        "adls": "AzureBlobFSReadSettings",
        "sql": "AzureSqlDatabaseSource",
        "rest": "RestSource"
    }

    def create(self, config: dict) -> dict:
        source_type = config.get("storageType", "blob")

        if source_type == "blob":
            return self._create_blob_source(config)
        elif source_type == "sql":
            return self._create_sql_source(config)
        elif source_type == "rest":
            return self._create_rest_source(config)
        else:
            raise ValueError(f"Unsupported source type: {source_type}")

    def _create_blob_source(self, config: dict) -> dict:
        return {
            "type": "DelimitedTextSource",
            "formatSettings": {
                "type": "DelimitedTextReadSettings"
            },
            "storeSettings": {
                "type": "AzureBlobStorageReadSettings",
                "recursive": config.get("recursive", True),
                "enablePartitionDiscovery": config.get("enablePartitionDiscovery", False)
            },
            "datasetSettings": {
                "type": "DelimitedText",
                "typeProperties": {
                    "location": {
                        "type": "AzureBlobStorageLocation",
                        "container": config["container"],
                        "fileName": config["fileName"]
                    },
                    "columnDelimiter": config.get("delimiter", ","),
                    "quoteChar": config.get("quoteChar", '"'),
                    "escapeChar": config.get("escapeChar", "\\"),
                    "firstRowAsHeader": config.get("firstRowAsHeader", True)
                },
                "schema": [],
                "externalReferences": {
                    "connection": config["connectionId"]
                },
                "annotations": []
            }
        }

    def _create_sql_source(self, config: dict) -> dict:
        return {
            "type": "AzureSqlDatabaseSource",
            "sqlReaderQuery": config.get("query"),
            "queryTimeout": config.get("queryTimeout", "02:00:00")
        }

    def _create_rest_source(self, config: dict) -> dict:
        return {
            "type": "RestSource",
            "httpRequestTimeout": config.get("timeout", "00:01:40"),
            "requestInterval": config.get("requestInterval", "00.00:00:00.010")
        }


class SinkFactory:
    """Factory for creating sink configurations"""

    def create(self, config: dict) -> dict:
        sink_type = config.get("sinkType", "sql")

        if sink_type == "sql":
            return self._create_sql_sink(config)
        elif sink_type == "lakehouse":
            return self._create_lakehouse_sink(config)
        elif sink_type == "blob":
            return self._create_blob_sink(config)
        else:
            raise ValueError(f"Unsupported sink type: {sink_type}")

    def _create_sql_sink(self, config: dict) -> dict:
        return {
            "type": "FabricSqlDatabaseSink",
            "preCopyScript": config.get("preCopyScript"),
            "sqlWriterUseTableLock": config.get("useTableLock", False),
            "writeBehavior": config.get("writeBehavior", "insert"),
            "datasetSettings": {
                "type": "FabricSqlDatabaseTable",
                "typeProperties": {
                    "schema": config["schema"],
                    "table": config["table"]
                },
                "schema": [],
                "connectionSettings": {
                    "name": config["databaseName"],
                    "properties": {
                        "type": "FabricSqlDatabase",
                        "typeProperties": {
                            "artifactId": config["artifactId"],
                            "workspaceId": config.get("workspaceId", "00000000-0000-0000-0000-000000000000")
                        },
                        "externalReferences": {
                            "connection": config["connectionId"]
                        },
                        "annotations": []
                    }
                },
                "annotations": []
            }
        }

    def _create_lakehouse_sink(self, config: dict) -> dict:
        return {
            "type": "LakehouseSink",
            "tableActionOption": config.get("tableAction", "append"),
            "datasetSettings": {
                "type": "LakehouseTable",
                "typeProperties": {
                    "table": config["table"]
                }
            }
        }

    def _create_blob_sink(self, config: dict) -> dict:
        return {
            "type": "DelimitedTextSink",
            "storeSettings": {
                "type": "AzureBlobStorageWriteSettings"
            },
            "formatSettings": {
                "type": "DelimitedTextWriteSettings",
                "quoteAllText": True,
                "fileExtension": ".csv"
            }
        }
```

### Application to Sample Pipeline

```python
# Using factories to recreate the weather pipeline
def create_weather_pipeline():
    """Create the weather data pipeline using Factory pattern"""

    # Configuration for the weather pipeline
    config = {
        "name": "Copy AW data",
        "source": {
            "storageType": "blob",
            "container": "contaw",
            "fileName": "acuriteweather.CSV",
            "delimiter": ",",
            "firstRowAsHeader": True,
            "connectionId": "029ea595-868f-4ac9-92fd-efa61156e80a"
        },
        "sink": {
            "sinkType": "sql",
            "schema": "stage",
            "table": "WxReading",
            "preCopyScript": "Truncate Table stage.WxReading;",
            "writeBehavior": "insert",
            "databaseName": "db20250618",
            "artifactId": "d1989a0e-2cfd-a430-4844-c648e8262295",
            "connectionId": "12dfab85-ef0b-4ce1-926e-d8d26085cf44"
        },
        "mappings": [
            {
                "source": {"name": "Timestamp", "type": "String"},
                "sink": {"name": "WxReadingDateTime", "physicalType": "nvarchar", "length": "55"}
            },
            # ... additional mappings
        ],
        "timeout": "0.12:00:00",
        "retry": 0
    }

    # Use factory to create the activity
    factory = CopyActivityFactory()
    activity = factory.create_activity("Copy", config)

    return {
        "properties": {
            "activities": [activity]
        }
    }

# Example: Creating different pipeline types
pipeline_factory = CopyActivityFactory()
weather_pipeline = pipeline_factory.create_activity("Copy", weather_config)

dataflow_factory = DataflowActivityFactory()
transform_pipeline = dataflow_factory.create_activity("Dataflow", transform_config)
```

---

## 2. Builder Pattern Implementation

### Pattern Structure

```python
class PipelineBuilder:
    """Builder for constructing complex FDF pipelines"""

    def __init__(self):
        self.pipeline = {
            "properties": {
                "activities": []
            }
        }

    def add_copy_activity(self, name: str) -> 'CopyActivityBuilder':
        """Add a Copy activity and return its builder"""
        return CopyActivityBuilder(self, name)

    def add_dataflow_activity(self, name: str, dataflow_name: str) -> 'PipelineBuilder':
        """Add a Dataflow activity"""
        activity = {
            "type": "Dataflow",
            "name": name,
            "typeProperties": {
                "dataflow": {"referenceName": dataflow_name}
            }
        }
        self.pipeline["properties"]["activities"].append(activity)
        return self

    def add_dependency(self, activity_name: str, depends_on: list) -> 'PipelineBuilder':
        """Add dependencies to an activity"""
        for activity in self.pipeline["properties"]["activities"]:
            if activity["name"] == activity_name:
                activity["dependsOn"] = depends_on
        return self

    def build(self) -> dict:
        """Build and return the final pipeline"""
        return self.pipeline


class CopyActivityBuilder:
    """Builder for Copy activity components"""

    def __init__(self, pipeline_builder: PipelineBuilder, name: str):
        self.pipeline_builder = pipeline_builder
        self.activity = {
            "type": "Copy",
            "name": name,
            "typeProperties": {},
            "policy": {},
            "dependsOn": []
        }

    def with_blob_source(self, container: str, file_name: str,
                        connection_id: str, delimiter: str = ",") -> 'CopyActivityBuilder':
        """Configure blob storage source"""
        self.activity["typeProperties"]["source"] = {
            "type": "DelimitedTextSource",
            "formatSettings": {"type": "DelimitedTextReadSettings"},
            "storeSettings": {
                "type": "AzureBlobStorageReadSettings",
                "recursive": True,
                "enablePartitionDiscovery": False
            },
            "datasetSettings": {
                "type": "DelimitedText",
                "typeProperties": {
                    "location": {
                        "type": "AzureBlobStorageLocation",
                        "container": container,
                        "fileName": file_name
                    },
                    "columnDelimiter": delimiter,
                    "quoteChar": '"',
                    "escapeChar": "\\",
                    "firstRowAsHeader": True
                },
                "schema": [],
                "externalReferences": {"connection": connection_id},
                "annotations": []
            }
        }
        return self

    def with_sql_sink(self, schema: str, table: str, database_name: str,
                     artifact_id: str, connection_id: str,
                     pre_copy_script: str = None) -> 'CopyActivityBuilder':
        """Configure SQL database sink"""
        self.activity["typeProperties"]["sink"] = {
            "type": "FabricSqlDatabaseSink",
            "sqlWriterUseTableLock": False,
            "writeBehavior": "insert",
            "datasetSettings": {
                "type": "FabricSqlDatabaseTable",
                "typeProperties": {
                    "schema": schema,
                    "table": table
                },
                "schema": [],
                "connectionSettings": {
                    "name": database_name,
                    "properties": {
                        "type": "FabricSqlDatabase",
                        "typeProperties": {
                            "artifactId": artifact_id,
                            "workspaceId": "00000000-0000-0000-0000-000000000000"
                        },
                        "externalReferences": {"connection": connection_id},
                        "annotations": []
                    }
                },
                "annotations": []
            }
        }

        if pre_copy_script:
            self.activity["typeProperties"]["sink"]["preCopyScript"] = pre_copy_script

        return self

    def with_column_mapping(self, source_name: str, sink_name: str,
                          source_type: str = "String",
                          sink_type: str = "nvarchar",
                          sink_length: str = "50") -> 'CopyActivityBuilder':
        """Add a column mapping"""
        if "translator" not in self.activity["typeProperties"]:
            self.activity["typeProperties"]["translator"] = {
                "type": "TabularTranslator",
                "mappings": [],
                "typeConversion": True,
                "typeConversionSettings": {
                    "allowDataTruncation": True,
                    "treatBooleanAsNumber": False
                }
            }

        mapping = {
            "source": {
                "name": source_name,
                "type": source_type,
                "physicalType": source_type
            },
            "sink": {
                "name": sink_name,
                "physicalType": sink_type,
                "length": sink_length
            }
        }

        self.activity["typeProperties"]["translator"]["mappings"].append(mapping)
        return self

    def with_policy(self, timeout: str = "0.12:00:00",
                   retry: int = 0,
                   retry_interval: int = 30) -> 'CopyActivityBuilder':
        """Configure activity policy"""
        self.activity["policy"] = {
            "timeout": timeout,
            "retry": retry,
            "retryIntervalInSeconds": retry_interval,
            "secureInput": False,
            "secureOutput": False
        }
        return self

    def enable_staging(self) -> 'CopyActivityBuilder':
        """Enable staging for the copy activity"""
        self.activity["typeProperties"]["enableStaging"] = True
        return self

    def and_then(self) -> PipelineBuilder:
        """Finish building this activity and return to pipeline builder"""
        self.pipeline_builder.pipeline["properties"]["activities"].append(self.activity)
        return self.pipeline_builder
```

### Application to Sample Pipeline

```python
# Build the weather pipeline using Builder pattern
def build_weather_pipeline():
    """Build weather pipeline using fluent builder interface"""

    pipeline = (PipelineBuilder()
        .add_copy_activity("Copy AW data")
            .with_blob_source(
                container="contaw",
                file_name="acuriteweather.CSV",
                connection_id="029ea595-868f-4ac9-92fd-efa61156e80a",
                delimiter=","
            )
            .with_sql_sink(
                schema="stage",
                table="WxReading",
                database_name="db20250618",
                artifact_id="d1989a0e-2cfd-a430-4844-c648e8262295",
                connection_id="12dfab85-ef0b-4ce1-926e-d8d26085cf44",
                pre_copy_script="Truncate Table stage.WxReading;"
            )
            .with_column_mapping("Timestamp", "WxReadingDateTime",
                               sink_length="55")
            .with_column_mapping("Outdoor Temperature", "WxReadingOutdoorTemperature",
                               sink_length="24")
            .with_column_mapping("Outdoor Humidity", "WxReadingOutdoorHumidity",
                               sink_length="24")
            .with_column_mapping("Dew Point", "WxReadingDewpoint",
                               sink_length="24")
            .with_column_mapping("Heat Index", "WxReadingHeatIndex",
                               sink_length="24")
            .with_column_mapping("Wind Chill", "WxReadingWindChill",
                               sink_length="24")
            .with_column_mapping("Barometric Pressure", "WxReadingBarometricPressure",
                               sink_length="24")
            .with_column_mapping("Rain", "WxReadingRain",
                               sink_length="24")
            .with_column_mapping("Wind Speed", "WxReadingWindSpeed",
                               sink_length="24")
            .with_column_mapping("Wind Average", "WxReadingWindAverage",
                               sink_length="24")
            .with_column_mapping("Peak Wind", "WxReadingPeakWind",
                               sink_length="24")
            .with_column_mapping("Wind Direction", "WxReadingWindDirection",
                               sink_length="24")
            .with_column_mapping("Indoor Temperature", "WxReadingIndoorTemperature",
                               sink_length="24")
            .with_column_mapping("Indoor Humidity", "WxReadingIndoorHumidity",
                               sink_length="24")
            .with_policy(timeout="0.12:00:00", retry=0, retry_interval=30)
            .and_then()
        .build()
    )

    return pipeline

# Example: Building a multi-activity pipeline
def build_complex_pipeline():
    """Build a pipeline with multiple activities and dependencies"""

    pipeline = (PipelineBuilder()
        .add_copy_activity("Extract Weather Data")
            .with_blob_source("contaw", "weather.csv", "conn-001")
            .with_sql_sink("stage", "WxStaging", "db01", "artifact-001", "conn-002")
            .with_policy(timeout="0.06:00:00", retry=2)
            .and_then()
        .add_dataflow_activity("Transform Weather", "df_transform_weather")
        .add_copy_activity("Load to DW")
            .with_sql_sink("dw", "FactWeather", "dwdb", "artifact-002", "conn-003")
            .with_policy(timeout="0.12:00:00", retry=0)
            .and_then()
        .add_dependency("Transform Weather",
                       [{"activity": "Extract Weather Data", "dependencyConditions": ["Succeeded"]}])
        .add_dependency("Load to DW",
                       [{"activity": "Transform Weather", "dependencyConditions": ["Succeeded"]}])
        .build()
    )

    return pipeline
```

---

## 3. Template Method Pattern Implementation

### Pattern Structure

```python
from abc import ABC, abstractmethod

class PipelineTemplate(ABC):
    """Template for pipeline execution workflow"""

    def execute(self, context: dict) -> dict:
        """Template method defining the pipeline execution workflow"""

        # Initialize
        self.initialize(context)

        # Pre-execution validation
        if not self.validate_inputs(context):
            raise ValueError("Input validation failed")

        # Extract data
        source_data = self.extract(context)

        # Pre-processing
        processed_data = self.pre_process(source_data, context)

        # Transform (optional, can be overridden)
        transformed_data = self.transform(processed_data, context)

        # Load to destination
        result = self.load(transformed_data, context)

        # Post-processing
        self.post_process(result, context)

        # Cleanup
        self.cleanup(context)

        return result

    def initialize(self, context: dict):
        """Initialize pipeline execution (can be overridden)"""
        print(f"Initializing pipeline: {context.get('pipelineName', 'Unknown')}")

    @abstractmethod
    def validate_inputs(self, context: dict) -> bool:
        """Validate input parameters (must be implemented)"""
        pass

    @abstractmethod
    def extract(self, context: dict) -> any:
        """Extract data from source (must be implemented)"""
        pass

    def pre_process(self, data: any, context: dict) -> any:
        """Pre-process data before transformation (can be overridden)"""
        return data

    def transform(self, data: any, context: dict) -> any:
        """Transform data (can be overridden, default is pass-through)"""
        return data

    @abstractmethod
    def load(self, data: any, context: dict) -> dict:
        """Load data to destination (must be implemented)"""
        pass

    def post_process(self, result: dict, context: dict):
        """Post-process after load (can be overridden)"""
        pass

    def cleanup(self, context: dict):
        """Cleanup resources (can be overridden)"""
        print("Pipeline execution completed")


class CopyPipelineTemplate(PipelineTemplate):
    """Template for Copy activity pipelines"""

    def validate_inputs(self, context: dict) -> bool:
        """Validate Copy pipeline inputs"""
        required = ["sourceConnection", "sinkConnection", "sourceLocation", "sinkLocation"]
        return all(key in context for key in required)

    def extract(self, context: dict) -> any:
        """Extract data from source"""
        source_type = context["sourceType"]

        if source_type == "blob":
            return self._extract_from_blob(context)
        elif source_type == "sql":
            return self._extract_from_sql(context)
        else:
            raise ValueError(f"Unsupported source type: {source_type}")

    def _extract_from_blob(self, context: dict) -> any:
        """Extract from blob storage"""
        print(f"Reading from blob: {context['sourceLocation']}")
        # Simulate data extraction
        return {"data": "extracted_blob_data"}

    def _extract_from_sql(self, context: dict) -> any:
        """Extract from SQL database"""
        print(f"Querying SQL: {context.get('query', 'SELECT * FROM table')}")
        return {"data": "extracted_sql_data"}

    def pre_process(self, data: any, context: dict) -> any:
        """Pre-process: Execute pre-copy script if specified"""
        if "preCopyScript" in context:
            print(f"Executing pre-copy script: {context['preCopyScript']}")
        return data

    def load(self, data: any, context: dict) -> dict:
        """Load data to sink"""
        sink_type = context["sinkType"]

        if sink_type == "sql":
            return self._load_to_sql(data, context)
        elif sink_type == "lakehouse":
            return self._load_to_lakehouse(data, context)
        else:
            raise ValueError(f"Unsupported sink type: {sink_type}")

    def _load_to_sql(self, data: any, context: dict) -> dict:
        """Load to SQL database"""
        table = f"{context['sinkSchema']}.{context['sinkTable']}"
        print(f"Loading to SQL table: {table}")
        return {"status": "success", "rowsWritten": 1000}

    def _load_to_lakehouse(self, data: any, context: dict) -> dict:
        """Load to lakehouse"""
        print(f"Loading to lakehouse table: {context['sinkTable']}")
        return {"status": "success", "rowsWritten": 1000}


class ETLPipelineTemplate(PipelineTemplate):
    """Template for ETL pipelines with transformation"""

    def validate_inputs(self, context: dict) -> bool:
        """Validate ETL pipeline inputs"""
        required = ["sourceConnection", "sinkConnection", "transformationLogic"]
        return all(key in context for key in required)

    def extract(self, context: dict) -> any:
        """Extract data"""
        print(f"Extracting from {context['sourceType']}")
        return {"data": "raw_data"}

    def transform(self, data: any, context: dict) -> any:
        """Apply transformation logic"""
        transformation = context["transformationLogic"]
        print(f"Applying transformation: {transformation}")

        # Execute transformation steps
        for step in transformation.get("steps", []):
            data = self._apply_transformation_step(data, step)

        return data

    def _apply_transformation_step(self, data: any, step: dict) -> any:
        """Apply a single transformation step"""
        step_type = step["type"]
        print(f"  - Applying {step_type}")
        # Transformation logic here
        return data

    def load(self, data: any, context: dict) -> dict:
        """Load transformed data"""
        print(f"Loading to {context['sinkType']}")
        return {"status": "success", "rowsWritten": 500}
```

### Application to Sample Pipeline

```python
# Use template for weather pipeline
def execute_weather_pipeline():
    """Execute weather pipeline using template method"""

    # Define execution context
    context = {
        "pipelineName": "Weather Data Copy",
        "sourceType": "blob",
        "sourceConnection": "029ea595-868f-4ac9-92fd-efa61156e80a",
        "sourceLocation": "contaw/acuriteweather.CSV",
        "sinkType": "sql",
        "sinkConnection": "12dfab85-ef0b-4ce1-926e-d8d26085cf44",
        "sinkSchema": "stage",
        "sinkTable": "WxReading",
        "preCopyScript": "Truncate Table stage.WxReading;",
        "timeout": "0.12:00:00",
        "retryPolicy": {
            "retry": 0,
            "retryInterval": 30
        }
    }

    # Execute using template
    pipeline = CopyPipelineTemplate()
    result = pipeline.execute(context)

    return result

# Custom pipeline with overridden methods
class WeatherPipelineTemplate(CopyPipelineTemplate):
    """Custom template for weather data processing"""

    def pre_process(self, data: any, context: dict) -> any:
        """Custom pre-processing for weather data"""
        # Execute truncate
        super().pre_process(data, context)

        # Additional weather-specific validation
        print("Validating weather data format...")
        return data

    def post_process(self, result: dict, context: dict):
        """Custom post-processing"""
        print(f"Weather data loaded: {result['rowsWritten']} readings")
        print("Triggering downstream weather analysis pipeline...")
```

---

## 4. Strategy Pattern Implementation

### Pattern Structure

```python
from abc import ABC, abstractmethod

# Strategy interfaces
class SourceStrategy(ABC):
    """Strategy interface for data sources"""

    @abstractmethod
    def read_data(self, config: dict) -> dict:
        """Read data from source"""
        pass

    @abstractmethod
    def get_source_config(self, params: dict) -> dict:
        """Generate source configuration"""
        pass


class SinkStrategy(ABC):
    """Strategy interface for data sinks"""

    @abstractmethod
    def write_data(self, data: any, config: dict) -> dict:
        """Write data to sink"""
        pass

    @abstractmethod
    def get_sink_config(self, params: dict) -> dict:
        """Generate sink configuration"""
        pass


class TransformStrategy(ABC):
    """Strategy interface for transformations"""

    @abstractmethod
    def transform(self, data: any, config: dict) -> any:
        """Transform data"""
        pass


# Concrete source strategies
class BlobStorageSource(SourceStrategy):
    """Strategy for reading from Azure Blob Storage"""

    def read_data(self, config: dict) -> dict:
        container = config["container"]
        file_name = config["fileName"]
        print(f"Reading from blob: {container}/{file_name}")
        return {"data": "blob_data", "format": "csv"}

    def get_source_config(self, params: dict) -> dict:
        return {
            "type": "DelimitedTextSource",
            "formatSettings": {
                "type": "DelimitedTextReadSettings"
            },
            "storeSettings": {
                "type": "AzureBlobStorageReadSettings",
                "recursive": params.get("recursive", True),
                "enablePartitionDiscovery": params.get("enablePartitionDiscovery", False)
            },
            "datasetSettings": {
                "type": "DelimitedText",
                "typeProperties": {
                    "location": {
                        "type": "AzureBlobStorageLocation",
                        "container": params["container"],
                        "fileName": params["fileName"]
                    },
                    "columnDelimiter": params.get("delimiter", ","),
                    "firstRowAsHeader": params.get("firstRowAsHeader", True)
                },
                "externalReferences": {
                    "connection": params["connectionId"]
                }
            }
        }


class SQLDatabaseSource(SourceStrategy):
    """Strategy for reading from SQL Database"""

    def read_data(self, config: dict) -> dict:
        query = config.get("query", f"SELECT * FROM {config['table']}")
        print(f"Executing query: {query}")
        return {"data": "sql_data"}

    def get_source_config(self, params: dict) -> dict:
        return {
            "type": "AzureSqlDatabaseSource",
            "sqlReaderQuery": params.get("query"),
            "queryTimeout": params.get("queryTimeout", "02:00:00"),
            "isolationLevel": params.get("isolationLevel", "ReadCommitted")
        }


class RestAPISource(SourceStrategy):
    """Strategy for reading from REST API"""

    def read_data(self, config: dict) -> dict:
        endpoint = config["endpoint"]
        print(f"Calling REST API: {endpoint}")
        return {"data": "api_data"}

    def get_source_config(self, params: dict) -> dict:
        return {
            "type": "RestSource",
            "httpRequestTimeout": params.get("timeout", "00:01:40"),
            "requestInterval": params.get("requestInterval", "00.00:00:00.010"),
            "requestMethod": params.get("method", "GET")
        }


# Concrete sink strategies
class SQLDatabaseSink(SinkStrategy):
    """Strategy for writing to SQL Database"""

    def write_data(self, data: any, config: dict) -> dict:
        table = f"{config['schema']}.{config['table']}"
        write_behavior = config.get("writeBehavior", "insert")
        print(f"Writing to SQL table: {table} (behavior: {write_behavior})")
        return {"rowsWritten": 1000}

    def get_sink_config(self, params: dict) -> dict:
        return {
            "type": "FabricSqlDatabaseSink",
            "preCopyScript": params.get("preCopyScript"),
            "sqlWriterUseTableLock": params.get("useTableLock", False),
            "writeBehavior": params.get("writeBehavior", "insert"),
            "datasetSettings": {
                "type": "FabricSqlDatabaseTable",
                "typeProperties": {
                    "schema": params["schema"],
                    "table": params["table"]
                },
                "connectionSettings": {
                    "name": params["databaseName"],
                    "properties": {
                        "type": "FabricSqlDatabase",
                        "typeProperties": {
                            "artifactId": params["artifactId"],
                            "workspaceId": params.get("workspaceId", "00000000-0000-0000-0000-000000000000")
                        },
                        "externalReferences": {
                            "connection": params["connectionId"]
                        }
                    }
                }
            }
        }


class LakehouseSink(SinkStrategy):
    """Strategy for writing to Lakehouse"""

    def write_data(self, data: any, config: dict) -> dict:
        table = config["table"]
        action = config.get("tableAction", "append")
        print(f"Writing to lakehouse table: {table} (action: {action})")
        return {"rowsWritten": 1000}

    def get_sink_config(self, params: dict) -> dict:
        return {
            "type": "LakehouseSink",
            "tableActionOption": params.get("tableAction", "append"),
            "datasetSettings": {
                "type": "LakehouseTable",
                "typeProperties": {
                    "table": params["table"]
                }
            }
        }


class BlobStorageSink(SinkStrategy):
    """Strategy for writing to Blob Storage"""

    def write_data(self, data: any, config: dict) -> dict:
        container = config["container"]
        file_name = config["fileName"]
        print(f"Writing to blob: {container}/{file_name}")
        return {"filesWritten": 1}

    def get_sink_config(self, params: dict) -> dict:
        return {
            "type": "DelimitedTextSink",
            "storeSettings": {
                "type": "AzureBlobStorageWriteSettings"
            },
            "formatSettings": {
                "type": "DelimitedTextWriteSettings",
                "quoteAllText": True,
                "fileExtension": params.get("fileExtension", ".csv")
            }
        }


# Concrete transform strategies
class PassThroughTransform(TransformStrategy):
    """Strategy for pass-through (no transformation)"""

    def transform(self, data: any, config: dict) -> any:
        return data


class MappingTransform(TransformStrategy):
    """Strategy for column mapping transformation"""

    def transform(self, data: any, config: dict) -> any:
        mappings = config.get("mappings", [])
        print(f"Applying {len(mappings)} column mappings")
        # Apply mapping logic
        return data


# Pipeline context using strategies
class StrategyPipeline:
    """Pipeline that uses strategies for flexibility"""

    def __init__(self, source: SourceStrategy, sink: SinkStrategy,
                 transform: TransformStrategy = None):
        self.source = source
        self.sink = sink
        self.transform = transform or PassThroughTransform()

    def execute(self, config: dict) -> dict:
        """Execute pipeline using configured strategies"""

        # Extract using source strategy
        data = self.source.read_data(config["source"])

        # Transform using transform strategy
        transformed = self.transform.transform(data, config.get("transform", {}))

        # Load using sink strategy
        result = self.sink.write_data(transformed, config["sink"])

        return result

    def generate_config(self, source_params: dict, sink_params: dict,
                       transform_params: dict = None) -> dict:
        """Generate FDF JSON configuration using strategies"""

        activity = {
            "type": "Copy",
            "typeProperties": {
                "source": self.source.get_source_config(source_params),
                "sink": self.sink.get_sink_config(sink_params),
                "enableStaging": False
            }
        }

        return activity
```

### Application to Sample Pipeline

```python
# Create weather pipeline with strategies
def create_weather_pipeline_with_strategies():
    """Create weather pipeline using Strategy pattern"""

    # Choose strategies
    source = BlobStorageSource()
    sink = SQLDatabaseSink()
    transform = MappingTransform()

    # Create pipeline with chosen strategies
    pipeline = StrategyPipeline(source, sink, transform)

    # Generate configuration
    source_params = {
        "container": "contaw",
        "fileName": "acuriteweather.CSV",
        "delimiter": ",",
        "firstRowAsHeader": True,
        "connectionId": "029ea595-868f-4ac9-92fd-efa61156e80a"
    }

    sink_params = {
        "schema": "stage",
        "table": "WxReading",
        "preCopyScript": "Truncate Table stage.WxReading;",
        "writeBehavior": "insert",
        "databaseName": "db20250618",
        "artifactId": "d1989a0e-2cfd-a430-4844-c648e8262295",
        "connectionId": "12dfab85-ef0b-4ce1-926e-d8d26085cf44"
    }

    config = pipeline.generate_config(source_params, sink_params)

    return config


# Example: Easily swap strategies for different scenarios
def create_lakehouse_pipeline():
    """Same source, different sink - easy to swap"""

    source = BlobStorageSource()  # Same source
    sink = LakehouseSink()         # Different sink

    pipeline = StrategyPipeline(source, sink)

    # Different sink parameters
    sink_params = {
        "table": "WeatherReadings",
        "tableAction": "append"
    }

    return pipeline.generate_config(source_params, sink_params)


def create_api_to_blob_pipeline():
    """Completely different source and sink"""

    source = RestAPISource()
    sink = BlobStorageSink()

    pipeline = StrategyPipeline(source, sink)

    # REST API parameters
    api_params = {
        "endpoint": "https://api.weather.gov/stations/KORD/observations",
        "method": "GET",
        "timeout": "00:02:00"
    }

    # Blob sink parameters
    blob_params = {
        "container": "raw-data",
        "fileName": "weather_api_response.json",
        "fileExtension": ".json"
    }

    return pipeline.generate_config(api_params, blob_params)
```

---

## Pattern Combination Examples

### Combining All Four Patterns

```python
class FDFPipelineGenerator:
    """
    Master class combining all four GoF patterns for FDF pipeline generation
    """

    def __init__(self):
        # Factory for creating components
        self.activity_factory = CopyActivityFactory()
        self.source_factory = SourceFactory()
        self.sink_factory = SinkFactory()

        # Strategy registry
        self.source_strategies = {
            "blob": BlobStorageSource(),
            "sql": SQLDatabaseSource(),
            "rest": RestAPISource()
        }

        self.sink_strategies = {
            "sql": SQLDatabaseSink(),
            "lakehouse": LakehouseSink(),
            "blob": BlobStorageSink()
        }

    def generate_pipeline(self, spec: dict) -> dict:
        """
        Generate pipeline from specification
        Combines: Factory + Builder + Strategy + Template Method
        """

        # Use Builder pattern for construction
        builder = PipelineBuilder()

        # Process each activity in spec
        for activity_spec in spec.get("activities", []):
            activity_type = activity_spec["type"]

            if activity_type == "Copy":
                self._add_copy_activity(builder, activity_spec)
            elif activity_type == "Dataflow":
                self._add_dataflow_activity(builder, activity_spec)

        return builder.build()

    def _add_copy_activity(self, builder: PipelineBuilder, spec: dict):
        """Add copy activity using Factory and Strategy patterns"""

        # Get strategies based on configuration
        source_type = spec["source"]["type"]
        sink_type = spec["sink"]["type"]

        source_strategy = self.source_strategies[source_type]
        sink_strategy = self.sink_strategies[sink_type]

        # Build activity using Builder
        activity_builder = builder.add_copy_activity(spec["name"])

        # Configure source using Strategy
        if source_type == "blob":
            activity_builder.with_blob_source(
                container=spec["source"]["container"],
                file_name=spec["source"]["fileName"],
                connection_id=spec["source"]["connectionId"]
            )

        # Configure sink using Strategy
        if sink_type == "sql":
            activity_builder.with_sql_sink(
                schema=spec["sink"]["schema"],
                table=spec["sink"]["table"],
                database_name=spec["sink"]["databaseName"],
                artifact_id=spec["sink"]["artifactId"],
                connection_id=spec["sink"]["connectionId"],
                pre_copy_script=spec["sink"].get("preCopyScript")
            )

        # Add mappings
        for mapping in spec.get("mappings", []):
            activity_builder.with_column_mapping(
                source_name=mapping["source"],
                sink_name=mapping["sink"]
            )

        # Set policy
        activity_builder.with_policy(
            timeout=spec.get("timeout", "0.12:00:00"),
            retry=spec.get("retry", 0)
        )

        activity_builder.and_then()

    def _add_dataflow_activity(self, builder: PipelineBuilder, spec: dict):
        """Add dataflow activity using Factory pattern"""
        builder.add_dataflow_activity(spec["name"], spec["dataflowName"])


# Usage example
def generate_weather_pipeline_with_all_patterns():
    """Generate weather pipeline using all four patterns"""

    generator = FDFPipelineGenerator()

    # High-level specification
    spec = {
        "activities": [
            {
                "type": "Copy",
                "name": "Copy AW data",
                "source": {
                    "type": "blob",
                    "container": "contaw",
                    "fileName": "acuriteweather.CSV",
                    "connectionId": "029ea595-868f-4ac9-92fd-efa61156e80a"
                },
                "sink": {
                    "type": "sql",
                    "schema": "stage",
                    "table": "WxReading",
                    "databaseName": "db20250618",
                    "artifactId": "d1989a0e-2cfd-a430-4844-c648e8262295",
                    "connectionId": "12dfab85-ef0b-4ce1-926e-d8d26085cf44",
                    "preCopyScript": "Truncate Table stage.WxReading;"
                },
                "mappings": [
                    {"source": "Timestamp", "sink": "WxReadingDateTime"},
                    {"source": "Outdoor Temperature", "sink": "WxReadingOutdoorTemperature"},
                    # ... more mappings
                ],
                "timeout": "0.12:00:00",
                "retry": 0
            }
        ]
    }

    pipeline = generator.generate_pipeline(spec)
    return pipeline
```

---

## Summary: Pattern Application Matrix

| Component | Factory | Builder | Template | Strategy |
|-----------|---------|---------|----------|----------|
| **Pipeline Creation** | ✓ | ✓ | ✓ | - |
| **Activity Selection** | ✓ | - | - | ✓ |
| **Source Config** | ✓ | ✓ | - | ✓ |
| **Sink Config** | ✓ | ✓ | - | ✓ |
| **Mappings** | - | ✓ | - | - |
| **Execution Flow** | - | - | ✓ | ✓ |
| **Error Handling** | - | - | ✓ | ✓ |

---

## Recommendations for Implementation

1. **Start with Builder Pattern**
   - Most intuitive for pipeline construction
   - Immediate improvement in code readability

2. **Add Factory for Component Creation**
   - Centralize creation logic
   - Enable dynamic component selection

3. **Implement Strategy for Swappable Components**
   - Make pipelines configuration-driven
   - Easy testing with different sources/sinks

4. **Apply Template Method for Execution**
   - Standardize pipeline workflows
   - Ensure consistent error handling and logging

5. **Combine All Patterns**
   - Use the `FDFPipelineGenerator` approach
   - Maximum flexibility and maintainability

---

## Next Steps for PASS Project

1. Prototype these patterns with the weather pipeline
2. Create Claude prompts that leverage these patterns
3. Design parameter extraction based on pattern structure
4. Integrate with Durandal for pattern storage
5. Build user-facing templates for rapid pipeline generation

This catalog provides the foundation for converting FDF pipelines into reusable, pattern-based templates that can be rapidly deployed using Claude Code.
