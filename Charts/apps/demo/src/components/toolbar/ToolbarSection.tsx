// ToolbarSection Component
// Visual divider between button groups

interface ToolbarSectionProps {
    variant?: 'light' | 'heavy';
}

export const ToolbarSection: React.FC<ToolbarSectionProps> = ({ variant = 'light' }) => {
    return (
        <div className={`toolbar-section toolbar-section--${variant}`} />
    );
};
