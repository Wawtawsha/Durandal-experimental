# Initial Prompt for Claude Code Web Instance

## Copy and paste this entire prompt when starting your Claude Code Web session:

---

I need you to work on a structured project for PASS Data Community Summit. You'll be converting Microsoft Fabric Data Factory (FDF) pipelines into reusable design patterns.

**Project Location:** The PASS GitHub repository

**Your Role:** Execute 7 interdependent tasks to create a system that converts FDF pipelines into design patterns, extracts parameters, stores them in Durandal, and enables rapid pipeline generation.

**Instructions:**

1. First, read these files in order:
   - `README.md` - Project overview and status tracking
   - `PASS_ORCHESTRATION.md` - Detailed task breakdown with dependencies
   - `assets/pipeline-content.json` - Sample FDF pipeline

2. Start with TASK-001 (no dependencies). Each task has:
   - Unique ID (TASK-XXX)
   - Blockers (tasks that must complete first)
   - Deliverables (what you must produce)

3. For each task:
   - Create a working branch
   - Research and document findings in `/documentation/task-XXX/`
   - Produce deliverables in `/deliverables/task-XXX/`
   - Update task status in README.md
   - Commit with format: `[TASK-XXX] Description`

4. Task Dependencies (must follow this order):
   ```
   TASK-001 → TASK-002 → TASK-003 → TASK-004 → TASK-005/006 → TASK-007
   ```

5. Key Technical Goals:
   - Extract parameters from the pipeline JSON
   - Define a pattern template structure
   - Create prompts for Claude to perform conversions
   - Integrate with Durandal MCP for storage
   - Build a system for pattern + parameters = new pipeline

6. Remember:
   - This is for teaching at a conference
   - Focus on clarity and educational value
   - The pipeline is real production data (weather ETL)
   - Document everything for presentation purposes

Please confirm you understand the project structure and are ready to begin with TASK-001.

---

## Additional Context for Complex Tasks

### For TASK-004 (Claude Instructions):
Focus on creating a structured prompt that can:
- Identify parameterizable elements (connection IDs, table names, column mappings)
- Extract these as a separate configuration
- Convert the remaining structure into a reusable template

### For TASK-005 (Durandal Storage):
Consider using Durandal's memory capabilities to:
- Store pattern templates with metadata
- Index patterns by type and use case
- Enable quick retrieval for Claude Code

### For TASK-007 (User Prompts):
Create a user-friendly interface where users can:
- Select a pattern from Durandal
- Provide their specific parameters
- Generate a complete, working pipeline JSON

---

End of initial prompt. This should give Claude Code Web everything needed to execute the project systematically.