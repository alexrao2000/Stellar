"""Scheduling rules belong to a task series, including after a rename.

These are current planning preferences, separate from historic completion rules.
Clients receive task identity and version titles so records and booked slots can
be reconciled across renames. No title automatically enables outdoor planning.
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, model_validator

from .calendar_connections import _db, owner

router = APIRouter()


class PlanningRule(BaseModel):
    enabled: bool = True
    duration_minutes: int = Field(default=15, ge=5, le=480)
    earliest: int = Field(default=420, ge=0, le=1439)
    latest: int = Field(default=1260, ge=0, le=1440)
    weather: Literal['any', 'dry', 'sunny'] = 'any'
    daylight_only: bool = False
    min_temperature_c: float = Field(default=2, ge=-40, le=50)
    max_temperature_c: float = Field(default=30, ge=-40, le=50)
    max_rain_percent: int = Field(default=30, ge=0, le=100)
    max_wind_kph: int = Field(default=40, ge=0, le=120)
    buffer_minutes: int = Field(default=0, ge=0, le=120)

    @model_validator(mode='after')
    def valid_window(self):
        if self.max_temperature_c < self.min_temperature_c:
            raise ValueError('The maximum temperature must be above the minimum')
        duration = (self.latest - self.earliest) % 1440 or 1440
        if self.duration_minutes > duration:
            raise ValueError('The task must fit inside its allowed time window')
        return self


@router.get('/api/calendar/task-planning')
def planning(request: Request, response: Response):
    from . import server
    response.headers['Cache-Control'] = 'no-store'
    user = owner(request)
    rows = _db().table('task_planning_rules').select('series_id,rule,updated_at').eq('owner_id', user).execute().data or []
    rules = {row['series_id']: row for row in rows}
    tasks = []
    definitions = server._definitions()
    for sid, versions, version in server._current_series(definitions):
        if not any(v.get('active') for v in versions) or not all(server._live(v) for v in versions):
            continue
        summary = server._task_summary(versions)
        if summary.get('binned'): continue
        stored = rules.get(sid, {})
        tasks.append({'series_id': sid, 'title': summary['title'], 'titles': sorted({v['title'] for v in versions}),
                      'starts_on': min((v.get('starts_on') or '0001-01-01') for v in versions), 'ends_on': summary.get('ends_on'),
                      'rule': PlanningRule(**stored.get('rule', {})).model_dump(), 'updated_at': stored.get('updated_at')})
    return {'tasks': tasks, 'defaults': PlanningRule().model_dump()}


@router.put('/api/calendar/task-planning/{series_id}')
def save_planning(series_id: int, body: PlanningRule, request: Request):
    from . import server
    if series_id not in server._series(server._definitions(fresh=True)):
        raise HTTPException(404, 'Task not found')
    user = owner(request)
    existing = _db().table('task_planning_rules').select('series_id').eq('owner_id', user).eq('series_id', series_id).execute().data or []
    values = {'rule': body.model_dump()}
    query = _db().table('task_planning_rules')
    if existing:
        rows = query.update(values).eq('owner_id', user).eq('series_id', series_id).execute().data or []
    else:
        rows = query.insert({'owner_id': user, 'series_id': series_id, **values}).execute().data or []
    return {'series_id': series_id, 'rule': body.model_dump(), 'updated_at': rows[0]['updated_at']}
