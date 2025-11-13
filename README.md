# PASS Data Community Summit - FDF Pipeline Pattern Project

## Quick Start for Claude Code Web

This repository contains the orchestration for converting Microsoft Fabric Data Factory pipelines into reusable design patterns.

### Your Mission
Transform FDF pipelines into design patterns that can be rapidly scaled, tested, and developed using Claude Code.

### Files Structure
```
/
├── PASS_ORCHESTRATION.md     # Detailed task breakdown with dependencies
├── assets/
│   └── pipeline-content.json  # Sample FDF pipeline (Load AndyWeather)
├── documentation/            # Place task research here
│   └── task-XXX/
└── deliverables/            # Place final outputs here
    └── task-XXX/
```

### How to Process Tasks

1. **Read `PASS_ORCHESTRATION.md`** - Contains all 7 tasks with dependencies
2. **Start with TASK-001** - No blockers, fundamental research
3. **Follow dependency chain** - Don't start a task until its blockers are complete
4. **Document everything** - Create markdown files in `/documentation/`
5. **Store deliverables** - Place final outputs in `/deliverables/`

### Key Objectives

- Extract parameters from pipelines
- Create industry-standard design patterns
- Store patterns in Durandal for rapid access
- Enable users to generate new pipelines from patterns + parameters

### Critical Context

- This is for a pre-conference workshop at PASS Data Community Summit
- Attendees will learn to use Claude to scale their FDF pipelines
- Focus on educational value and practical demonstrations
- The sample pipeline (pipeline-content.json) is a real-world weather data ETL

### Task Status Tracking

Update this section as you complete tasks:

- [ ] TASK-001: Pattern Fundamentals
- [ ] TASK-002: Industry Standards
- [ ] TASK-003: FDF Blueprint Analysis
- [ ] TASK-004: Claude Instructions
- [ ] TASK-005: Durandal Storage
- [ ] TASK-006: Combination Logic
- [ ] TASK-007: User Prompts

### Communication Protocol

When working on tasks:
1. Create a branch: `task-XXX-description`
2. Commit with format: `[TASK-XXX] What you did`
3. Update status in this README
4. If blocked, document the blocker and move to next available task

### Success Metrics

- Working prototype that converts pipelines to patterns
- Clear documentation for presentation
- Durandal integration for pattern storage
- User-friendly prompts for pattern instantiation