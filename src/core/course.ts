import type { SimulationState } from '../contracts';
import { parseState } from '../state';
import { parseLandscape } from '../platform/landscape-data';
import type { Landscape } from '../platform/landscape-data';

export interface CourseStep { title: string; text: string; durationSeconds: number; scene: SimulationState }
export interface Course { version: 1; title: string; steps: CourseStep[] }
export interface CoursePackage { format: 'sky-course-package'; version: 1; course: Course; landscape: Landscape | null }
export interface CourseDraft {
  version: 1; course: Course; landscape: Landscape | null; includeLandscape: boolean;
  stepTitle: string; stepText: string; stepDuration: string;
}
export const COURSE_MAX_BYTES = 2_000_000;
export const COURSE_PACKAGE_MAX_BYTES = 14_000_000;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

function parseCourseValue(value: unknown, allowEmpty: boolean): Course {
  const raw = value as Course;
  if (!raw || raw.version !== 1 || typeof raw.title !== 'string' || raw.title.length > 120 || !Array.isArray(raw.steps)
    || (!allowEmpty && !raw.steps.length) || raw.steps.length > 100) throw new Error('课程需要标题及 1–100 个步骤。');
  return { version: 1, title: raw.title, steps: raw.steps.map(step => {
    if (!step || typeof step.title !== 'string' || step.title.length > 120 || typeof step.text !== 'string' || step.text.length > 4000
      || !Number.isFinite(step.durationSeconds) || step.durationSeconds < 2 || step.durationSeconds > 600) {
      throw new Error('步骤标题/讲解无效，时长需为 2–600 秒。');
    }
    const scene = parseState(step.scene); scene.time.running = false;
    return { title: step.title, text: step.text, durationSeconds: step.durationSeconds, scene };
  }) };
}
export function parseCourse(input: string | unknown): Course {
  if (typeof input === 'string' && bytes(input) > COURSE_MAX_BYTES) throw new Error('课程文件最大 2 MB。');
  return parseCourseValue(typeof input === 'string' ? JSON.parse(input) : input, false);
}
/** The optional panorama is stored once for the whole lesson, never inside individual scenes. */
export function parseCoursePackage(input: string | unknown): CoursePackage {
  if (typeof input === 'string' && bytes(input) > COURSE_PACKAGE_MAX_BYTES) throw new Error('课程包最大 14 MB。');
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  if (value?.format === 'sky-course-package') {
    if (value.version !== 1 || !('landscape' in value)) throw new Error('不支持此课程包版本。');
    const course = parseCourse(JSON.stringify(value.course));
    return { format: 'sky-course-package', version: 1, course, landscape: value.landscape === null ? null : parseLandscape(value.landscape) };
  }
  return { format: 'sky-course-package', version: 1, course: parseCourse(typeof input === 'string' ? input : JSON.stringify(input)), landscape: null };
}
export function parseCourseDraft(value: unknown): CourseDraft {
  const raw = value as CourseDraft;
  if (!raw || raw.version !== 1 || typeof raw.includeLandscape !== 'boolean' || typeof raw.stepTitle !== 'string' || raw.stepTitle.length > 120
    || typeof raw.stepText !== 'string' || raw.stepText.length > 4000 || typeof raw.stepDuration !== 'string' || raw.stepDuration.length > 32) {
    throw new Error('课程草稿无法读取。');
  }
  return { version: 1, course: parseCourseValue(raw.course, true), landscape: raw.landscape === null ? null : parseLandscape(raw.landscape),
    includeLandscape: raw.includeLandscape, stepTitle: raw.stepTitle, stepText: raw.stepText, stepDuration: raw.stepDuration };
}
