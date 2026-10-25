'use strict'
/**
 * This file is a trimmed down version of the fitCreator.ts, which can be found at {@link https://github.com/JaapvanEkris/openrowingmonitor|OpenRowingMonitor}
 *
 * @file This module generates the fit-file content for a recorded rowing session: it contains
 * the session and the strokes (records) as defined by the Garmin fit and rowing data standard specifications.
 * It assumes that something persistsed every stroke, split, and interval, and this module reads a
 * session back and encodes it in the fit format. sessionToFit(sessionId) is the entry point.
 *
 * This uses 'Smart Recording' per stroke as that makes sure that per-stroke data can also be extracted from the file (like work per stroke)
 * The RowingDtata standard calls this 'Stroke-Boundary Recording', which is assumed to be managed by the recorder.
 * @see {@link https://developer.garmin.com/fit/file-types/activity/|the fields and their meaning}.
 * @see {@link https://github.com/markw65/fit-file-writer/blob/main/src/fit-tables.ts|for a list of all available fields and their types}.
 * @see {@link https://developer.garmin.com/fit/cookbook/encoding-activity-files/|the description of the filestructure and how timestamps}
 * @see {@link https://forums.garmin.com/developer/fit-sdk/b/news-announcements/posts/important-fit-activity-file-message-change|description of the timestamps for summary messages}
 * @see {@link https://developer.garmin.com/fit/cookbook/durations/|how the different times are defined}
 * @see {@link https://github.com/MoveLab-Studio/rowing-data-standard/blob/main/spec/FIT_STANDARD.md|the harmonised rowing data FIT specifications for definitions and interpretations}
 * We use 'summary last message sequencing' as the stream makes most sense that way
 * As general timestamp we use the session end time, as that is semantically more sound than Garmin's approach of the session start time
 *
 * BE AWARE: general rowing and Garmin FIT terminology conflict:
 * - a fit-file 'split' is written from a rowing interval, and
 * - a fit-file 'lap' from a rowing split.
 */
import log from 'loglevel'
import { FitWriter, fit_messages } from '@markw65/fit-file-writer'
import { createDatabase } from './utils/store.ts'
import type { Session, Interval, Split, Stroke } from './utils/store.ts'

/** Everything of a session the fit encoding consumes, as read from the store. */
interface WorkoutData {
  session: Session
  intervals: Interval[]
  splits: Split[]
  strokes: Stroke[]
}

/** A developer field value as the FitWriter takes it. */
interface DeveloperFieldValue {
  developer_data_index: number
  field_num: number
  value: number | number[]
}

/**
 * @description Reads the session from the database and returns its fit-file
 * content, or undefined when the session is unknown or has no usable data.
 * Opens (and closes) its own store connection.
 */
export async function sessionToFit (sessionId: number, dbPath?: string): Promise<DataView | undefined> {
  const store = createDatabase(dbPath)
  try {
    const session = store.getSession(sessionId)
    if (session === undefined) {
      log.error(`fitRecorder: unknown session ${sessionId}`)
      return undefined
    }
    if (session.complete === null || !((session.complete ?? 0) > 0)) {
      log.debug(`fitRecorder: session ${sessionId} is not marked complete (yet), is the session still active?`)
      return undefined
    }
    if (session.endTime === null || !((session.totalMovingTime ?? 0) > 0) || !((session.totalLinearDistance ?? 0) > 0)) {
      log.debug(`fitRecorder: session ${sessionId} has no usable data for a fit-file`)
      return undefined
    }
    const workout: WorkoutData = {
      session,
      intervals: store.getIntervals(sessionId),
      splits: store.getSplits(sessionId),
      strokes: store.getStrokesWithBoundaries(sessionId)
    }
    return await workoutToFit(workout)
  } finally {
    store.close()
  }
}

/**
 * @description This function generates the entire fit-file from the session's
 * database rows. We use 'summary last message sequencing' as the stream makes
 * most sense that way.
 */
export async function workoutToFit (workout: WorkoutData): Promise<DataView | undefined> {
  const { session, splits } = workout
  const fitWriter = new FitWriter()
  const versionNumber = parseInt(process.env.npm_package_version ?? '0', 10)
  const startTime = new Date(session.startTime)
  const endTime = new Date(session.endTime as number)
  const maxForceCurvePointCount = session.maxForceCurveLength ?? 0
  const totalNoLaps = splits.length ?? 0
  const totalTime = msToFitSeconds(session.totalTime)
  const totalMovingTime = msToFitSeconds(session.totalMovingTime)

  // The file header
  fitWriter.writeMessage(
    'file_id',
    {
      time_created: fitWriter.time(endTime),
      type: 'activity',
      manufacturer: 'development',
      product: 0,
      number: 0
    },
    null,
    true
  )

  fitWriter.writeMessage(
    'file_creator',
    {
      software_version: 1
    },
    null,
    true
  )

  /**
   * Register the developer data source and developer fields
   * @see {@link https://github.com/MoveLab-Studio/rowing-data-standard/blob/main/spec/FIT_STANDARD.md|the harmonised rowing data FIT specifications for definitions and more information}
   */
  fitWriter.writeMessage(
    'developer_data_id',
    {
      application_id: '89e86158-6d47-5c98-9d46-7d29437f27b9'
        .replace(/-/g, '')
        .match(/../g)
        .map((s) => parseInt(s, 16)),
      developer_data_index: 0,
      // The protocol version of the rowing data standard, not the software version
      application_version: 1
    },
    null,
    true
  )

  // Registering each developer field individually
  fitWriter.writeMessage(
    'field_description',
    {
      developer_data_index: 0,
      field_definition_number: 0,
      fit_base_type_id: 'uint16',
      field_name: 'DriveLength',
      scale: 1,
      units: 'mm'
    },
    null,
    true
  )

  fitWriter.writeMessage(
    'field_description',
    {
      developer_data_index: 0,
      field_definition_number: 1,
      fit_base_type_id: 'uint16',
      field_name: 'StrokeDriveTime',
      scale: 1,
      units: 'ms'
    },
    null,
    true
  )

  fitWriter.writeMessage(
    'field_description',
    {
      developer_data_index: 0,
      field_definition_number: 2,
      fit_base_type_id: 'uint16',
      field_name: 'DragFactor',
      scale: 1,
    },
    null,
    true
  )

  fitWriter.writeMessage(
    'field_description',
    {
      developer_data_index: 0,
      field_definition_number: 3,
      fit_base_type_id: 'uint16',
      field_name: 'StrokeRecoveryTime',
      scale: 1,
      units: 'ms'
    },
    null,
    true
  )

  // Write the Force curve dependent values only when there is a force curve to report
  if (maxForceCurvePointCount > 0) {
    fitWriter.writeMessage(
      'field_description',
      {
        developer_data_index: 0,
        field_definition_number: 6,
        fit_base_type_id: 'uint16',
        field_name: 'AverageDriveForce',
        scale: 10,
        units: 'N'
      },
      null,
      true
    )

    fitWriter.writeMessage(
      'field_description',
      {
        developer_data_index: 0,
        field_definition_number: 7,
        fit_base_type_id: 'uint16',
        field_name: 'PeakDriveForce',
        scale: 10,
        units: 'N'
      },
      null,
      true
    )
  }

  fitWriter.writeMessage(
    'field_description',
    {
      developer_data_index: 0,
      field_definition_number: 8,
      fit_base_type_id: 'uint16',
      field_name: 'AverageBoatSpeed',
      scale: 100,
      units: 'm/s'
    },
    null,
    true
  )

  fitWriter.writeMessage(
    'field_description',
    {
      developer_data_index: 0,
      field_definition_number: 9,
      fit_base_type_id: 'uint8',
      field_name: 'WorkoutState',
      scale: 1
    },
    null,
    true
  )

  fitWriter.writeMessage(
    'field_description',
    {
      developer_data_index: 0,
      field_definition_number: 10,
      fit_base_type_id: 'uint8',
      field_name: 'RecordingStrategy',
      scale: 1
    },
    null,
    true
  )

  // Write the Force curve dependent values only when there is a force curve to report
  if (maxForceCurvePointCount > 0) {
    fitWriter.writeMessage(
      'field_description',
      {
        developer_data_index: 0,
        field_definition_number: 17,
        fit_base_type_id: 'uint16',
        field_name: 'PeakForcePositionNorm',
        scale: 100,
        units: '%'
      },
      null,
      true
    )

    fitWriter.writeMessage(
      'field_description',
      {
        developer_data_index: 0,
        field_definition_number: 18,
        fit_base_type_id: 'uint16',
        field_name: 'PeakForcePositionAbs',
        scale: 1,
        units: 'mm'
      },
      null,
      true
    )
  }

  fitWriter.writeMessage(
    'field_description',
    {
      developer_data_index: 0,
      field_definition_number: 19,
      fit_base_type_id: 'uint16',
      field_name: 'StrokeWork',
      scale: 1,
      units: 'J'
    },
    null,
    true
  )

  // Write the Force curve dependent values only when there is a force curve to report
  if (maxForceCurvePointCount > 0) {
    fitWriter.writeMessage(
      'field_description',
      {
        developer_data_index: 0,
        field_definition_number: 60,
        fit_base_type_id: 'uint16',
        array: maxForceCurvePointCount,
        scale: 10,
        field_name: 'HandleForceCurve',
        units: 'N'
      },
      null,
      true
    )

    fitWriter.writeMessage(
      'field_description',
      {
        developer_data_index: 0,
        field_definition_number: 90,
        fit_base_type_id: 'uint8',
        field_name: 'InstrokeAbscissaType',
        scale: 1
      },
      null,
      true
    )

    fitWriter.writeMessage(
      'field_description',
      {
        developer_data_index: 0,
        field_definition_number: 91,
        fit_base_type_id: 'uint16',
        field_name: 'InstrokeSampleInterval',
        scale: 1,
        units: 'mm'
      },
      null,
      true
    )

    fitWriter.writeMessage(
      'field_description',
      {
        developer_data_index: 0,
        field_definition_number: 92,
        fit_base_type_id: 'uint8',
        field_name: 'InstrokePointCount',
        scale: 1
      },
      null,
      true
    )
  }

  // Activity summary
  fitWriter.writeMessage(
    'activity',
    {
      timestamp: fitWriter.time(endTime),
      local_timestamp: fitWriter.time(startTime) - startTime.getTimezoneOffset() * 60,
      ...(totalTime != undefined ? { total_timer_time: totalTime } : {}),
      num_sessions: 1,
      event: 'activity',
      event_type: 'stop',
      type: 'manual'
    },
    null,
    true
  )

  // BE AWARE: the manufacturer name currently prevents issues with certain consumers, as these tend to relax parsing requirements!
  fitWriter.writeMessage(
    'device_info',
    {
      timestamp: fitWriter.time(endTime),
      device_index: 0,
      device_type: 0,
      manufacturer: 'development',
      product_name: 'OpenRowingMonitor'
    },
    null,
    true
  )

  fitWriter.writeMessage(
    'sport',
    {
      sport: 'rowing',
      sub_sport: 'indoorRowing',
      name: 'Indoor rowing'
    },
    null,
    true
  )

  /*
   * The session summary
   */
  const sessionDragFactor = toFitUint16(session.dragFactor)
  const developerFieldValues: DeveloperFieldValue[] = [
    ...(sessionDragFactor != undefined ? [{ developer_data_index: 0, field_num: 2, value: sessionDragFactor }] : []),
    // RecordingStrategy: StrokeBoundary
    { developer_data_index: 0, field_num: 10, value: 1 }
  ]

  fitWriter.writeMessage(
    'session',
    {
      timestamp: fitWriter.time(endTime),
      message_index: 0,
      sport: 'rowing',
      sub_sport: 'indoorRowing',
      event: 'session',
      event_type: 'stop',
      trigger: 'activityEnd',
      sport_profile_name: 'Row Indoor',
      start_time: fitWriter.time(startTime),
      ...(totalTime != undefined ? { total_elapsed_time: totalTime } : {}),
      ...(totalTime != undefined ? { total_timer_time: totalTime } : {}),
      ...(totalMovingTime != undefined ? { total_moving_time: totalMovingTime } : {}),
      ...(session.totalLinearDistance != undefined ? { total_distance: session.totalLinearDistance } : {}),
      ...(session.totalWork != undefined ? { total_work: session.totalWork } : {}),
      ...(session.totalCalories != undefined ? { total_calories: session.totalCalories } : {}),
      ...(session.strokeCount != undefined ? { total_cycles: session.strokeCount } : {}),
      ...(session.averageLinearVelocity != undefined ? { avg_speed: session.averageLinearVelocity } : {}),
      ...(session.maximumLinearVelocity != undefined ? { max_speed: session.maximumLinearVelocity } : {}),
      ...(session.averagePower != undefined ? { avg_power: session.averagePower } : {}),
      ...(session.maximumPower != undefined ? { max_power: session.maximumPower } : {}),
      ...(session.averageHandleAvgForce != undefined ? { avg_force: session.averageHandleAvgForce } : {}),
      ...(session.maximumHandleAvgForce != undefined ? { max_force: session.maximumHandleAvgForce } : {}),
      ...((session?.averageStrokerate ?? 0) > 0 && session.averageStrokerate <= 127 ? { avg_cadence: session.averageStrokerate } : {}),
      ...((session?.maximumStrokerate ?? 0) > 0 && session.maximumStrokerate <= 127 ? { max_cadence: session.maximumStrokerate } : {}),
      ...((session?.minimumHeartrate ?? 0) > 0 && session.minimumHeartrate < 250 ? { min_heart_rate: session.minimumHeartrate } : {}),
      ...((session?.averageHeartrate ?? 0) > 0 && session.averageHeartrate < 250 ? { avg_heart_rate: session.averageHeartrate } : {}),
      ...((session?.maximumHeartrate ?? 0) > 0 && session.maximumHeartrate < 250 ? { max_heart_rate: session.maximumHeartrate } : {}),
      ...(session.averageStrokeDistance != undefined ? { avg_stroke_distance: session.averageStrokeDistance } : {}),
      first_lap_index: 0,
      num_laps: totalNoLaps
    },
    developerFieldValues,
    true
  )

  // Write the splits
  await writeSplits(fitWriter, workout)

  // Write the laps
  await writeLaps(fitWriter, workout)

  // Write the events
  await writeEvents(fitWriter, workout)

  await writeRecords(fitWriter, workout, maxForceCurvePointCount)

  return fitWriter.finish()
}

/**
 * Creation of all Garmin fit-splits (= rowing intervals). The split summaries classify
 * the HR of the strokes into active and rest by replaying the rest-split windows.
 * As no strokes occur during a rest, the rest HR can only come from the boundary
 * markers at the start and end of that rest.
 */
async function writeSplits (writer: any, workout: WorkoutData): Promise<void> {
  const { session, intervals, strokes } = workout
  const endTime = new Date(session.endTime as number)
  const activeIntervals = intervals.filter(i => i.intensity === 'active')
  const restIntervals = intervals.filter(i => i.intensity !== 'active')
  const activeTimerTime = msToFitSeconds(session.totalMovingTime)
  const restTimerTime = msToFitSeconds(session.totalRestTime)

  // Classify the HR of the strokes by whether they fall inside a rest split's window.
  const restWindows = workout.splits
    .filter(s => s.intensity !== 'active' && s.endTime !== null)
    .map(s => ({ start: s.startTime, end: s.endTime as number }))
  const inRest = (t: number): boolean => restWindows.some(w => t >= w.start && t <= w.end)
  let activeSum = 0; let activeCount = 0; let activeMax = 0
  let restSum = 0; let restCount = 0; let restMax = 0
  for (const r of strokes) {
    if (!(r.heartrate > 0)) continue
    if (inRest(r.timestamp)) {
      restSum += r.heartrate; restCount++; if (r.heartrate > restMax) restMax = r.heartrate
    } else {
      activeSum += r.heartrate; activeCount++; if (r.heartrate > activeMax) activeMax = r.heartrate
    }
  }
  const activeAvg = activeCount > 0 ? activeSum / activeCount : 0
  const restAvg = restCount > 0 ? restSum / restCount : 0

  // Write the split summary
  writer.writeMessage(
    'split_summary',
    {
      timestamp: writer.time(endTime),
      message_index: 0,
      split_type: 'interval_active',
      num_splits: activeIntervals.length,
      ...(activeTimerTime != undefined ? { total_timer_time: activeTimerTime } : {}),
      ...(session.totalLinearDistance != undefined ? { total_distance: session.totalLinearDistance } : {}),
      ...(session.averageLinearVelocity != undefined ? { avg_speed: session.averageLinearVelocity } : {}),
      ...(session.maximumLinearVelocity != undefined ? { max_speed: session.maximumLinearVelocity } : {}),
      ...((session.averageStrokerate ?? 0) > 0 ? { avg_cadence: session.averageStrokerate } : {}),
      ...((session.maximumStrokerate ?? 0) > 0 ? { max_cadence: session.maximumStrokerate } : {}),
      ...(session.totalMovingCalories != undefined ? { total_calories: session.totalMovingCalories } : {}),
      ...(activeAvg > 0 ? { avg_heart_rate: activeAvg } : {}),
      ...(activeMax > 0 ? { max_heart_rate: activeMax } : {})
    },
    null,
    restIntervals.length === 0
  )

  if (restIntervals.length > 0) {
    // There was a pause
    writer.writeMessage(
      'split_summary',
      {
        timestamp: writer.time(endTime),
        message_index: 1,
        split_type: 'interval_rest',
        num_splits: restIntervals.length,
        ...(restTimerTime != undefined ? { total_timer_time: restTimerTime } : {}),
        total_distance: 0,
        avg_speed: 0,
        max_speed: 0,
        avg_cadence: 0,
        max_cadence: 0,
        ...(session.totalRestCalories != undefined ? { total_calories: session.totalRestCalories } : {}),
        ...(restAvg > 0 ? { avg_heart_rate: restAvg } : {}),
        ...(restMax > 0 ? { max_heart_rate: restMax } : {})
      },
      null,
      true
    )
  }

  // Create the individual splits
  let i = 0
  while (i < intervals.length) {
    if (intervals[i].intensity === 'active') {
      await createActiveSplit(writer, workout, intervals[i])
    } else {
      // This is a rest interval
      await createRestSplit(writer, workout, intervals[i])
    }
    i++
  }
}

/**
 * Creation of the active fit-split (= Rowing interval)
 */
async function createActiveSplit (writer: any, workout: WorkoutData, interval: Interval): Promise<void> {
  if (interval.complete !== true) { return }
  const endTime = new Date(workout.session.endTime as number)
  const totalTime = msToFitSeconds(interval.totalTime)
  const totalMovingTime = msToFitSeconds(interval.totalMovingTime)
  const dragFactor = toFitUint16(interval.dragFactor)
  const developerFieldValues: DeveloperFieldValue[] = [
    ...(dragFactor != undefined ? [{ developer_data_index: 0, field_num: 2, value: dragFactor }] : [])
  ]

  writer.writeMessage(
    'split',
    {
      timestamp: writer.time(endTime),
      message_index: interval.intervalNumber,
      ...(interval.firstSplitNumber != undefined ? { lap_index: interval.firstSplitNumber } : {}),
      sport: 'rowing',
      sub_sport: 'indoorRowing',
      split_type: 'interval_active',
      ...(totalTime != undefined ? { total_elapsed_time: totalTime } : {}),
      ...(totalTime != undefined ? { total_timer_time: totalTime } : {}),
      ...(totalMovingTime != undefined ? { total_moving_time: totalMovingTime } : {}),
      ...(interval.totalLinearDistance != undefined ? { total_distance: interval.totalLinearDistance } : {}),
      ...(interval.averageLinearVelocity != undefined ? { avg_speed: interval.averageLinearVelocity } : {}),
      ...(interval.maximumLinearVelocity != undefined ? { max_speed: interval.maximumLinearVelocity } : {}),
      ...(interval.averagePower != undefined ? { avg_power: interval.averagePower } : {}),
      ...(interval.maximumPower != undefined ? { max_power: interval.maximumPower } : {}),
      ...((interval.averageStrokerate ?? 0) > 0 ? { avg_cadence: interval.averageStrokerate } : {}),
      ...((interval.maximumStrokerate ?? 0) > 0 ? { max_cadence: interval.maximumStrokerate } : {}),
      ...(interval.calories != undefined ? { total_calories: interval.calories } : {}),
      start_time: writer.time(new Date(interval.startTime)),
      ...(interval.startDistance != undefined ? { start_distance: interval.startDistance } : {}),
      ...(interval.endTime != undefined ? { end_time: writer.time(new Date(interval.endTime)) } : {}),
      ...((interval.averageHeartrate ?? 0) > 0 ? { avg_heart_rate: interval.averageHeartrate } : {}),
      ...((interval.maximumHeartrate ?? 0) > 0 ? { max_heart_rate: interval.maximumHeartrate } : {})
    },
    developerFieldValues,
    (interval.intervalNumber + 1) === workout.intervals.length
  )
}

/**
 * Creation of the rest fit-split (= A planned rowing rest interval)
 */
async function createRestSplit (writer: any, workout: WorkoutData, interval: Interval): Promise<void> {
  if (interval.complete !== true) { return }
  const endTime = new Date(workout.session.endTime as number)
  const totalTime = msToFitSeconds(interval.totalTime)

  writer.writeMessage(
    'split',
    {
      timestamp: writer.time(endTime),
      message_index: interval.intervalNumber,
      ...(interval.firstSplitNumber != undefined ? { lap_index: interval.firstSplitNumber } : {}),
      sport: 'rowing',
      sub_sport: 'indoorRowing',
      split_type: 'interval_rest',
      ...(totalTime != undefined ? { total_elapsed_time: totalTime } : {}),
      ...(totalTime != undefined ? { total_timer_time: totalTime } : {}),
      total_moving_time: 0,
      total_distance: 0,
      avg_speed: 0,
      max_speed: 0,
      avg_power: 0,
      max_power: 0,
      avg_cadence: 0,
      max_cadence: 0,
      ...(interval.calories != undefined ? { total_calories: interval.calories } : {}),
      start_time: writer.time(new Date(interval.startTime)),
      ...(interval.startDistance != undefined ? { start_distance: interval.startDistance } : {}),
      ...(interval.endTime != undefined ? { end_time: writer.time(new Date(interval.endTime)) } : {}),
      ...((interval.averageHeartrate ?? 0) > 0 ? { avg_heart_rate: interval.averageHeartrate } : {}),
      ...((interval.maximumHeartrate ?? 0) > 0 ? { max_heart_rate: interval.maximumHeartrate } : {})
    },
    null,
    (interval.intervalNumber + 1) === workout.intervals.length
  )
}

async function writeLaps (writer: any, workout: WorkoutData): Promise<void> {
  // Write all laps
  let i = 0
  while (i < workout.splits.length) {
    if (workout.splits[i].intensity === 'active') {
      await createActiveLap(writer, workout, workout.splits[i])
    } else {
      // This is a rest split
      await createRestLap(writer, workout, workout.splits[i])
    }
    i++
  }
}

async function createActiveLap (writer: any, workout: WorkoutData, split: Split): Promise<void> {
  // It is an active lap, after we make sure it is a completed lap, we can write it
  if (split.complete !== true) { return }
  const endTime = new Date(workout.session.endTime as number)
  const totalNoLaps = workout.splits.length
  const totalTime = msToFitSeconds(split.totalTime)
  const totalMovingTime = msToFitSeconds(split.totalMovingTime)
  const dragFactor = toFitUint16(split.dragFactor)
  const developerFieldValues: DeveloperFieldValue[] = [
    ...(dragFactor != undefined ? [{ developer_data_index: 0, field_num: 2, value: dragFactor }] : [])
  ]

  writer.writeMessage(
    'lap',
    {
      timestamp: writer.time(endTime),
      message_index: split.splitNumber,
      sport: 'rowing',
      sub_sport: 'indoorRowing',
      event: split.fitEvent ?? 'lap',
      event_type: split.fitEventType ?? 'stop',
      intensity: 'active',
      ...(totalNoLaps === (split.splitNumber + 1) ? { lap_trigger: 'sessionEnd' } : { lap_trigger: split.fitLapTrigger ?? 'manual' }),
      start_time: writer.time(new Date(split.startTime)),
      ...(totalTime != undefined ? { total_elapsed_time: totalTime } : {}),
      ...(totalTime != undefined ? { total_timer_time: totalTime } : {}),
      ...(totalMovingTime != undefined ? { total_moving_time: totalMovingTime } : {}),
      ...(split.totalLinearDistance != undefined ? { total_distance: split.totalLinearDistance } : {}),
      ...(split.strokeCount != undefined ? { total_cycles: split.strokeCount } : {}),
      ...((split.averageStrokerate ?? 0) > 0 ? { avg_cadence: split.averageStrokerate } : {}),
      ...((split.maximumStrokerate ?? 0) > 0 ? { max_cadence: split.maximumStrokerate } : {}),
      ...(split.averageStrokeDistance != undefined ? { avg_stroke_distance: split.averageStrokeDistance } : {}),
      ...(split.workDone != undefined ? { total_work: split.workDone } : {}),
      ...(split.calories != undefined ? { total_calories: split.calories } : {}),
      ...(split.averageLinearVelocity != undefined ? { avg_speed: split.averageLinearVelocity } : {}),
      ...(split.maximumLinearVelocity != undefined ? { max_speed: split.maximumLinearVelocity } : {}),
      ...(split.averagePower != undefined ? { avg_power: split.averagePower } : {}),
      ...(split.maximumPower != undefined ? { max_power: split.maximumPower } : {}),
      ...(split.averageHandleAvgForce != undefined ? { avg_force: split.averageHandleAvgForce } : {}),
      ...(split.maximumHandleAvgForce != undefined ? { max_force: split.maximumHandleAvgForce } : {}),
      ...((split.minimumHeartrate ?? 0) > 0 ? { min_heart_rate: split.minimumHeartrate } : {}),
      ...((split.averageHeartrate ?? 0) > 0 ? { avg_heart_rate: split.averageHeartrate } : {}),
      ...((split.maximumHeartrate ?? 0) > 0 ? { max_heart_rate: split.maximumHeartrate } : {})
    },
    developerFieldValues,
    totalNoLaps === (split.splitNumber + 1)
  )
}

async function createRestLap (writer: any, workout: WorkoutData, split: Split): Promise<void> {
  // First, make sure the rest lap has ended
  if (split.endTime === null) { return }
  const endTime = new Date(workout.session.endTime as number)
  const totalNoLaps = workout.splits.length
  const totalTime = msToFitSeconds(split.totalTime)

  writer.writeMessage(
    'lap',
    {
      timestamp: writer.time(endTime),
      message_index: split.splitNumber,
      sport: 'rowing',
      sub_sport: 'indoorRowing',
      event: split.fitEvent ?? 'lap',
      event_type: split.fitEventType ?? 'stop',
      intensity: 'rest',
      lap_trigger: split.fitLapTrigger ?? 'manual',
      start_time: writer.time(new Date(split.startTime)),
      ...(totalTime != undefined ? { total_elapsed_time: totalTime } : {}),
      ...(totalTime != undefined ? { total_timer_time: totalTime } : {}),
      total_moving_time: 0,
      total_distance: 0,
      total_cycles: 0,
      avg_cadence: 0,
      max_cadence: 0,
      avg_stroke_distance: 0,
      ...(split.calories != undefined ? { total_calories: split.calories } : {}),
      avg_speed: 0,
      max_speed: 0,
      avg_power: 0,
      max_power: 0,
      ...((split.averageHeartrate ?? 0) > 0 ? { avg_heart_rate: split.averageHeartrate } : {}),
      ...((split.maximumHeartrate ?? 0) > 0 ? { max_heart_rate: split.maximumHeartrate } : {})
    },
    null,
    totalNoLaps === (split.splitNumber + 1)
  )
}

/**
 * Write all events to the FIT-file. The recorder does not store a timer-event
 * timeline; it is deduced here by replaying the rest splits: each rest split
 * stops the timer at its start and restarts it at its end.
 */
async function writeEvents (writer: any, workout: WorkoutData): Promise<void> {
  const startTime = new Date(workout.session.startTime)
  const endTime = new Date(workout.session.endTime as number)

  // Start of the session
  await addEvent(writer, startTime, 'timer', 'start')

  // Write all pauses
  let i = 0
  while (i < workout.splits.length) {
    const split = workout.splits[i]
    if (split.intensity !== 'active' && split.endTime !== null) {
      // This is a rest split
      await addEvent(writer, new Date(split.startTime), split.fitEvent ?? 'lap', 'stop')
      await addEvent(writer, new Date(split.endTime as number), 'timer', 'start')
    }
    i++
  }

  // Finish the session with a stop event
  await addEvent(writer, endTime, 'timer', 'stopAll')
}

async function addEvent (writer: any, time: Date, event: string, eventType: string): Promise<void> {
  writer.writeMessage(
    'event',
    {
      timestamp: writer.time(time),
      event: event,
      event_type: eventType,
      event_group: 0
    },
    null,
    true
  )
}

/**
 * @description This loops through all recorded strokes (including the boundary
 * markers, which anchor the laps and splits) and adds them to the fit-structure
 */
async function writeRecords (writer: any, workout: WorkoutData, maxForceCurvePointCount: number): Promise<void> {
  const { session, strokes, splits } = workout
  // The windows of the rest splits, which determine the WorkoutState of a record. The windows are
  // half-open: the end of a rest split is the start of the next split, and belongs to that one
  const restWindows = splits
    .filter(s => s.intensity !== 'active' && s.endTime !== null)
    .map(s => ({ start: s.startTime, end: s.endTime as number }))
  if ((session.totalMovingTime ?? 0) > 0 && strokes.length > 0 && (strokes[strokes.length - 1].totalLinearDistance ?? 0) > 0) {
    let i = 0
    while (i < strokes.length) {
      await createTrackPoint(writer, strokes[i], restWindows, maxForceCurvePointCount)
      i++
    }
  }
}

/**
 * @description This creates the individual stroke. As the FitWriter does not apply the
 * declared scale to developer fields, every developer value is scaled here (see toFitUint16).
 * Some consumers require boundary markers, to mark the start and end of a session and rest periods.
 * @see {@link https://github.com/MoveLab-Studio/rowing-data-standard/blob/main/spec/FIT_STANDARD.md|the harmonised rowing data FIT specifications for definitions and more information}
 */
async function createTrackPoint (writer: any, stroke: Stroke, restWindows: { start: number; end: number }[], maxForceCurvePointCount: number): Promise<void> {
  // WorkoutState uses the values of the native FIT intensity enum: 0 = active, 1 = rest
  const workoutState = restWindows.some(w => stroke.timestamp >= w.start && stroke.timestamp < w.end) ? 1 : 0

  // A boundary marker has a valid pace and power, unless it is at the end of a pause, as the flywheel was standing still
  // then. Only for those markers pace and power are reported as 0. The marker at the start of a pause is a normal one
  const isPauseEnd = stroke.boundaryMarker && restWindows.some(w => stroke.timestamp > w.start && stroke.timestamp <= w.end)
  const speed = isPauseEnd ? 0 : stroke.linearVelocity
  const power = isPauseEnd ? 0 : stroke.power

  const strokeWork = toFitUint16(stroke.strokeWork)
  const dragFactor = toFitUint16(stroke.dragFactor)
  const driveDuration = toFitUint16(stroke.driveDuration)
  const recoveryDuration = toFitUint16(stroke.recoveryDuration)
  const driveLength = toFitUint16(stroke.driveLength)
  const averageBoatSpeed = toFitUint16(stroke.linearVelocity, 100)
  const averageDriveForce = maxForceCurvePointCount > 0 ? toFitUint16(stroke.averageDriveForce, 10) : undefined
  const peakDriveForce = maxForceCurvePointCount > 0 ? toFitUint16(stroke.peakDriveForce, 10) : undefined

  // The absolute handle position (mm) at peak force is the normalised position (0-1) along the drive length
  const peakForcePositionAbs = Math.round((stroke.peakDriveForcePosition ?? 0) * (stroke.driveLength ?? 0))

  // The force curve is sampled uniformly along the handle distance (abscissa type 2). The sample interval is the
  // spacing of the samples over the full curve, so it stays correct when the curve has to be cut to the declared size
  const forceCurve = stroke.forceCurve ?? []
  const forceCurvePointCount = Math.min(forceCurve.length, maxForceCurvePointCount)
  const sampleInterval = forceCurve.length > 1 ? toFitUint16((stroke.driveLength ?? 0) / (forceCurve.length - 1)) : undefined

  // BE AWARE: all force curves must be padded/trimmed to exactly match maxForceCurvePointCount. Any underrun or overrun will crash both encoders and decoders!
  const forceCurveSamples = Array.from({ length: maxForceCurvePointCount }, (_, i) => {
    const force = i < forceCurvePointCount ? Number(forceCurve[i]) : 0
    return Number.isFinite(force) ? Math.min(65534, Math.max(0, Math.round(force * 10))) : 0
  })

  const developerFieldValues: DeveloperFieldValue[] = [
    { developer_data_index: 0, field_num: 9, value: workoutState },
    ...(strokeWork != undefined ? [{ developer_data_index: 0, field_num: 19, value: strokeWork }] : []),
    ...(dragFactor != undefined ? [{ developer_data_index: 0, field_num: 2, value: dragFactor }] : []),
    ...(driveDuration != undefined ? [{ developer_data_index: 0, field_num: 1, value: driveDuration }] : []),
    ...(recoveryDuration != undefined ? [{ developer_data_index: 0, field_num: 3, value: recoveryDuration }] : []),
    ...(driveLength != undefined ? [{ developer_data_index: 0, field_num: 0, value: driveLength }] : []),
    ...(averageBoatSpeed != undefined ? [{ developer_data_index: 0, field_num: 8, value: averageBoatSpeed }] : []),
    ...(averageDriveForce != undefined ? [{ developer_data_index: 0, field_num: 6, value: averageDriveForce }] : []),
    ...(peakDriveForce != undefined ? [{ developer_data_index: 0, field_num: 7, value: peakDriveForce }] : []),
    ...(peakDriveForce != undefined ? [{ developer_data_index: 0, field_num: 17, value: (stroke.peakDriveForcePosition ?? 0) * 100 }] : []),
    ...(peakDriveForce != undefined && Number.isFinite(peakForcePositionAbs) && peakForcePositionAbs >= 0 ? [{ developer_data_index: 0, field_num: 18, value: Math.min(65534, peakForcePositionAbs) }] : []),
    ...(forceCurvePointCount > 1 && (sampleInterval ?? 0) > 0
      ? [
          { developer_data_index: 0, field_num: 90, value: 2 },
          { developer_data_index: 0, field_num: 91, value: sampleInterval as number },
          { developer_data_index: 0, field_num: 92, value: forceCurvePointCount },
          { developer_data_index: 0, field_num: 60, value: forceCurveSamples }
        ]
      : [])
  ]

  writer.writeMessage(
    'record',
    {
      timestamp: writer.time(new Date(stroke.timestamp)),
      ...(stroke.totalLinearDistance != undefined ? { distance: stroke.totalLinearDistance } : {}),
      ...(stroke.totalWork != undefined ? { accumulated_power: stroke.totalWork } : {}),
      ...(stroke.totalCalories != undefined ? { calories: stroke.totalCalories } : {}),
      ...(stroke.strokeNumber != undefined ? { total_cycles: stroke.strokeNumber } : {}),
      activity_type: 'fitnessEquipment',
      ...(((speed ?? 0) > 0 || (stroke.boundaryMarker && speed != undefined)) ? { speed: speed } : {}),
      ...(((power ?? 0) > 0 || (stroke.boundaryMarker && power != undefined)) ? { power: power } : {}),
      // The integer cadence is rounded (not truncated), as the standard requires, and is stored in a uint8
      ...((stroke.strokeRate ?? 0) > 0 && Math.round(stroke.strokeRate as number) < 255 ? { cadence: Math.round(stroke.strokeRate as number) } : {}),
      ...((stroke.strokeRate ?? 0) > 0 ? { cadence256: stroke.strokeRate } : {}),
      ...((stroke.strokeDistance ?? 0) > 0 ? { cycle_length16: stroke.strokeDistance } : {}),
      ...((stroke.dragFactor ?? 0) > 0 && (stroke.dragFactor as number) < 255 ? { resistance: stroke.dragFactor } : {}), // As the data is stored in an int8, we need to guard against exceeding that
      ...((stroke.heartrate ?? 0) > 0 ? { heart_rate: stroke.heartrate } : {}),
      ...(stroke.averageDriveForce != undefined ? { force: stroke.averageDriveForce } : {})
    },
    developerFieldValues
  )
}

/*
 * Supporting functions
 */

/**
 * The database stores durations and periods as whole milliseconds, while the
 * FIT format's standard time fields (total_elapsed_time, total_timer_time,
 * total_moving_time and the like) are expressed in seconds. This converts a
 * stored millisecond value to the seconds the FIT field expects; null passes
 * through so an absent value stays absent.
 *
 */
function msToFitSeconds (ms: number | null | undefined): number | undefined {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined
  return ms / 1000
}

/**
 * The FitWriter only applies the declared scale to native fields. A developer
 * field value is written to the file as-is, so it has to be multiplied by the
 * scale declared in its field_description here, and rounded to an integer.
 * Returns undefined for a missing, non-numeric or non-positive value, so that
 * the field is left out of the file instead of holding invalid data. A value that
 * would not fit is clipped to 65534, as 65535 is the FIT invalid value of a uint16.
 * @see {@link https://github.com/MoveLab-Studio/rowing-data-standard/blob/main/spec/FIT_STANDARD.md|section 7.2 of the rowing data standard}
 */
function toFitUint16 (value: number | null | undefined, scale = 1): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value) || !(value > 0)) return undefined
  return Math.min(65534, Math.round(value * scale))
}
