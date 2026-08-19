use serde::Serialize;

pub const PET_WIDTH: f64 = 192.0;
pub const PET_HEIGHT: f64 = 208.0;
pub const PANEL_WIDTH: f64 = 280.0;
pub const PANEL_GAP: f64 = 8.0;
pub const PANEL_HEIGHT: f64 = 304.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Placement {
    pub horizontal: &'static str,
    pub vertical: &'static str,
}

impl Default for Placement {
    fn default() -> Self {
        Self {
            horizontal: "left",
            vertical: "up",
        }
    }
}

pub fn pet_size(scale: f64) -> (f64, f64) {
    ((PET_WIDTH * scale).round(), (PET_HEIGHT * scale).round())
}

pub fn window_size(scale: f64, expanded: bool) -> (f64, f64) {
    let (pet_width, pet_height) = pet_size(scale);
    if expanded {
        (
            pet_width + PANEL_GAP + PANEL_WIDTH,
            pet_height.max(PANEL_HEIGHT),
        )
    } else {
        (pet_width, pet_height)
    }
}

fn pet_offset(scale: f64, expanded: bool, placement: Placement) -> (f64, f64) {
    if !expanded {
        return (0.0, 0.0);
    }
    let (_, pet_height) = pet_size(scale);
    let (_, height) = window_size(scale, true);
    (
        if placement.horizontal == "left" {
            PANEL_WIDTH + PANEL_GAP
        } else {
            0.0
        },
        if placement.vertical == "up" {
            height - pet_height
        } else {
            0.0
        },
    )
}

pub fn pet_bounds(window: Rect, scale: f64, expanded: bool, placement: Placement) -> Rect {
    let (width, height) = pet_size(scale);
    let (offset_x, offset_y) = pet_offset(scale, expanded, placement);
    Rect {
        x: window.x + offset_x,
        y: window.y + offset_y,
        width,
        height,
    }
}

fn choose_placement(pet: Rect, scale: f64, work_area: Rect) -> Placement {
    let (pet_width, pet_height) = pet_size(scale);
    let (window_width, window_height) = window_size(scale, true);
    let left_space = pet.x - work_area.x;
    let right_space = work_area.x + work_area.width - (pet.x + pet_width);
    let up_space = pet.y - work_area.y;
    let down_space = work_area.y + work_area.height - (pet.y + pet_height);
    let horizontal_extra = window_width - pet_width;
    let vertical_extra = window_height - pet_height;
    Placement {
        horizontal: if left_space >= horizontal_extra || left_space >= right_space {
            "left"
        } else {
            "right"
        },
        vertical: if up_space >= vertical_extra || up_space >= down_space {
            "up"
        } else {
            "down"
        },
    }
}

fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    value.max(minimum).min(maximum)
}

fn window_for_pet(
    pet: Rect,
    scale: f64,
    expanded: bool,
    placement: Placement,
    work_area: Rect,
) -> Rect {
    let (width, height) = window_size(scale, expanded);
    let (offset_x, offset_y) = pet_offset(scale, expanded, placement);
    Rect {
        x: clamp(
            pet.x - offset_x,
            work_area.x,
            work_area.x + work_area.width - width,
        ),
        y: clamp(
            pet.y - offset_y,
            work_area.y,
            work_area.y + work_area.height - height,
        ),
        width,
        height,
    }
}

pub fn reflow(
    current: Rect,
    previous_scale: f64,
    previous_expanded: bool,
    previous_placement: Placement,
    next_scale: f64,
    next_expanded: bool,
    work_area: Rect,
) -> (Rect, Placement) {
    let old_pet = pet_bounds(
        current,
        previous_scale,
        previous_expanded,
        previous_placement,
    );
    let (next_width, next_height) = pet_size(next_scale);
    let desired_pet = Rect {
        x: old_pet.x + old_pet.width - next_width,
        y: old_pet.y + old_pet.height - next_height,
        width: next_width,
        height: next_height,
    };
    let placement = if next_expanded {
        choose_placement(desired_pet, next_scale, work_area)
    } else {
        previous_placement
    };
    (
        window_for_pet(desired_pet, next_scale, next_expanded, placement, work_area),
        placement,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };

    #[test]
    fn top_edge_expands_down_without_moving_pet() {
        let original = Rect {
            x: 1500.0,
            y: 0.0,
            width: 144.0,
            height: 156.0,
        };
        let (window, placement) = reflow(
            original,
            0.75,
            false,
            Placement::default(),
            0.75,
            true,
            AREA,
        );
        assert_eq!(placement.vertical, "down");
        assert_eq!(pet_bounds(window, 0.75, true, placement), original);
    }

    #[test]
    fn bottom_edge_expands_up_without_moving_pet() {
        let original = Rect {
            x: 1500.0,
            y: 924.0,
            width: 144.0,
            height: 156.0,
        };
        let (window, placement) = reflow(
            original,
            0.75,
            false,
            Placement::default(),
            0.75,
            true,
            AREA,
        );
        assert_eq!(placement.vertical, "up");
        assert_eq!(pet_bounds(window, 0.75, true, placement), original);
    }

    #[test]
    fn left_edge_expands_right_and_collapses_in_place() {
        let original = Rect {
            x: 0.0,
            y: 400.0,
            width: 144.0,
            height: 156.0,
        };
        let (expanded, placement) = reflow(
            original,
            0.75,
            false,
            Placement::default(),
            0.75,
            true,
            AREA,
        );
        assert_eq!(placement.horizontal, "right");
        let (collapsed, _) = reflow(expanded, 0.75, true, placement, 0.75, false, AREA);
        assert_eq!(collapsed, original);
    }
}
