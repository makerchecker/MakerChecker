// React form field definitions — name + description + a handler, but NOT tools.
export const loginFields = [
  {
    name: 'email',
    description: 'Your email address',
    handler: onChange,
    render: (props) => <Input {...props} />,
  },
  {
    name: 'password',
    description: 'Choose a strong password',
    handler: onSubmit,
  },
];
